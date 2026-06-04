import fs from "node:fs";
import type {
    AsyncAPIObject,
    ChannelObject,
    MessageObject,
    OperationObject,
    ReferenceObject,
    SchemaObject,
} from "asyncapi-types";
import { compile } from "json-schema-to-typescript";
import {
    addressToType,
    hasInBinding,
    resolveRef,
    toPascalCase,
} from "./utils.ts";

const [_, _2, target] = process.argv;

if (!target)
    throw new Error("Please provide target (http link to async api spec)");

const response = await fetch(target);

const asyncApi = (await response.json()) as AsyncAPIObject;

console.log(asyncApi);

if (!asyncApi.operations)
    throw new Error("No operations found in async api spec");

if (!asyncApi.channels) throw new Error("No channels found in async api spec");

const generatedFile: string[] = [];

const channelsGroupedByRef: Record<string, OperationObject[]> = {};

for (const operation of Object.values(asyncApi.operations)) {
    if (!("messages" in operation) || !operation.messages) continue;

    const channelRef = (operation.channel as ReferenceObject)?.$ref;
    if (channelRef) {
        channelsGroupedByRef[channelRef] =
            channelsGroupedByRef[channelRef] || [];
        channelsGroupedByRef[channelRef].push(operation);
    }
}

for (const [channelRef, operations] of Object.entries(channelsGroupedByRef)) {
    const channel = resolveRef<ChannelObject>(channelRef, asyncApi);
    if (!channel || !channel.title) {
        console.error(`Channel ${channelRef} not found`);
        continue;
    }

    generatedFile.push(
        `export namespace ${toPascalCase(`${channel.title}Channel`)} {`,
    );

    if (channel.bindings && "ws" in channel.bindings) {
        if (typeof channel.bindings.ws?.query === "object") {
            const querySchema =
                "$ref" in channel.bindings.ws.query
                    ? resolveRef<SchemaObject>(
                          channel.bindings.ws.query.$ref,
                          asyncApi,
                      )
                    : channel.bindings.ws.query;

            const queryInterface = await compile(
                // @ts-expect-error
                { additionalProperties: false, ...querySchema },
                "QueryType",
                {
                    bannerComment: "",
                },
            );
            generatedFile.push(queryInterface);
        }

        if (typeof channel.bindings.ws?.headers === "object") {
            const headersSchema =
                "$ref" in channel.bindings.ws.headers
                    ? resolveRef<SchemaObject>(
                          channel.bindings.ws.headers.$ref,
                          asyncApi,
                      )
                    : channel.bindings.ws.headers;

            const headersInterface = await compile(
                // @ts-expect-error
                { additionalProperties: false, ...headersSchema },
                "HeadersType",
                {
                    bannerComment: "",
                },
            );
            generatedFile.push(headersInterface);
        }
    }

    console.log(channelRef, operations);

    const commandMap: Record<string, string> = {};
    const eventMap: Record<string, string> = {};
    const rpcMap: Record<
        string,
        { input: string; output: string; errors: Record<string, string> }
    > = {};
    const serverRpcMap: Record<string, { input: string; output: string }> = {};

    // Resolves a `[Type.Literal(name), schema]` tuple message ref, emits its
    // TypeScript interface under `typeName`, and returns `{ name, typeName }`.
    async function compileMessageRef(
        ref: string,
        typeNameFor: (name: string) => string,
    ): Promise<{ name: string; typeName: string } | null> {
        const messageFromRef = resolveRef<MessageObject>(ref, asyncApi);
        if (!messageFromRef) {
            console.error(`Message ${ref} not found`);
            return null;
        }
        const [type, schema] = messageFromRef.payload.items;
        const name = type.const as string;
        const typeName = typeNameFor(name);

        const schemaInterface =
            "not" in schema && !Object.keys(schema.not).length
                ? `export type ${typeName} = never;`
                : await compile(
                      { additionalProperties: false, ...schema },
                      typeName,
                      {
                          bannerComment: "",
                          additionalProperties: false,
                      },
                  );
        generatedFile.push(schemaInterface);
        return { name, typeName };
    }

    for (const operation of operations) {
        if (!("messages" in operation) || !operation.messages) continue;

        // Server→client RPC: action "send" with a `reply`. messages[0] =
        // request (server→client), reply.messages[0] = reply (client→server).
        const isServerRpc = "x-ws-asyncapi-server-rpc" in operation;
        if (isServerRpc) {
            const reqRef = operation.messages[0];
            const reply = operation.reply;
            const repRef =
                reply && "messages" in reply ? reply.messages?.[0] : undefined;
            if (
                !reqRef ||
                !("$ref" in reqRef) ||
                !repRef ||
                !("$ref" in repRef)
            )
                continue;
            const input = await compileMessageRef(reqRef.$ref, (name) =>
                toPascalCase(`${name}Input`),
            );
            const output = await compileMessageRef(repRef.$ref, (name) =>
                toPascalCase(`${name}Output`),
            );
            if (input && output)
                serverRpcMap[input.name] = {
                    input: input.typeName,
                    output: output.typeName,
                };
            continue;
        }

        // Client→server RPC: action "receive" with a `reply`. messages[0] =
        // request, reply.messages[0] = reply.
        const isRpc =
            "x-ws-asyncapi-rpc" in operation ||
            (!!operation.reply && "messages" in operation.reply);

        if (isRpc) {
            const reqRef = operation.messages[0];
            const reply = operation.reply;
            const repRef =
                reply && "messages" in reply ? reply.messages?.[0] : undefined;
            if (
                !reqRef ||
                !("$ref" in reqRef) ||
                !repRef ||
                !("$ref" in repRef)
            )
                continue;

            const input = await compileMessageRef(reqRef.$ref, (name) =>
                toPascalCase(`${name}Input`),
            );
            const output = await compileMessageRef(repRef.$ref, (name) =>
                toPascalCase(`${name}Output`),
            );

            // declared, typed errors (code -> data type)
            const errors: Record<string, string> = {};
            const errorIndex = (
                operation as {
                    "x-ws-asyncapi-errors"?: Record<string, { $ref: string }>;
                }
            )["x-ws-asyncapi-errors"];
            if (input && errorIndex) {
                for (const [code, ref] of Object.entries(errorIndex)) {
                    if (!ref || !("$ref" in ref)) continue;
                    const compiled = await compileMessageRef(ref.$ref, () =>
                        toPascalCase(`${input.name}_${code}_Error`),
                    );
                    if (compiled) errors[code] = compiled.typeName;
                }
            }

            if (input && output) {
                rpcMap[input.name] = {
                    input: input.typeName,
                    output: output.typeName,
                    errors,
                };
            }
            continue;
        }

        for (const message of operation.messages) {
            if (!("$ref" in message)) continue;

            const result = await compileMessageRef(message.$ref, (name) =>
                toPascalCase(
                    operation.action === "receive"
                        ? `${name}CommandData`
                        : `${name}EventData`,
                ),
            );
            if (!result) continue;

            if (operation.action === "receive") {
                commandMap[result.name] = result.typeName;
            } else {
                eventMap[result.name] = result.typeName;
            }
        }
    }
    // if (Object.keys(commandMap).length)
    generatedFile.push(
        `export interface CommandMap {
        ${Object.entries(commandMap)
            .map(([key, value]) => `"${key}": ${value}`)
            .join("\n")}
        }`,
    );

    // if (Object.keys(eventMap).length)
    generatedFile.push(
        `export interface EventMap {
        ${Object.entries(eventMap)
            .map(([key, value]) => `"${key}": ${value}`)
            .join("\n")}
        }`,
    );

    generatedFile.push(
        `export interface RpcMap {
        ${Object.entries(rpcMap)
            .map(([key, value]) => {
                const errs = Object.entries(value.errors)
                    .map(([code, type]) => `"${code}": ${type}`)
                    .join("; ");
                return `"${key}": { input: ${value.input}; output: ${value.output}; errors: { ${errs} } }`;
            })
            .join("\n")}
        }`,
    );

    generatedFile.push(
        `export interface ServerRpcMap {
        ${Object.entries(serverRpcMap)
            .map(
                ([key, value]) =>
                    `"${key}": { input: ${value.input}; output: ${value.output} }`,
            )
            .join("\n")}
        }`,
    );

    generatedFile.push("}");
}

const serversRaw = asyncApi.servers
    ? Object.values(asyncApi.servers).filter((server) => "protocol" in server)
    : [];

const servers = serversRaw.length
    ? serversRaw.map((x) => x.host)
    : [new URL(target).host];

// console.log(servers);

const channels = asyncApi.channels
    ? (Object.values(asyncApi.channels).filter(
          (channel) => "address" in channel && channel.address,
          // TODO: remove cast
      ) as ChannelObject[])
    : [];

// console.log(channels);

generatedFile.push(
    "export interface WebsocketAddresses {",
    `${channels
        .map(
            (x) =>
                `/** ${x.address} */\n"${x.title}": \`${addressToType(x.address!)}\``,
        )
        .join("\n")}`,
    "}",
);

// TODO: Подумать с точки зрения каналов
generatedFile.push(
    "export interface WebsocketServers {",
    `${servers.map((x) => `"${x}": string`).join("\n")}`,
    "}",
);

generatedFile.push(`declare module "@ws-asyncapi/client" {
        export interface WebsocketAsyncAPIMap {
        addresses: WebsocketAddresses, 
            data: {
                ${channels
                    .map(
                        (channel) => `"${channel.title}": {
                    ${hasInBinding(channel, "query") ? `query: ${toPascalCase(`${channel.title}Channel`)}.QueryType` : ""}
                    ${hasInBinding(channel, "headers") ? `headers: ${toPascalCase(`${channel.title}Channel`)}.HeadersType` : ""}
                    commandMap:  ${toPascalCase(`${channel.title}Channel`)}.CommandMap;
                    eventMap: ${toPascalCase(`${channel.title}Channel`)}.EventMap;
                    rpcMap: ${toPascalCase(`${channel.title}Channel`)}.RpcMap;
                    serverRpcMap: ${toPascalCase(`${channel.title}Channel`)}.ServerRpcMap;
                }`,
                    )
                    .join("\n")}
            }
        }
    }`);

fs.writeFileSync("generated.ts", generatedFile.join("\n"));
