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

/**
 * Turn a fetched AsyncAPI document into the TypeScript declaration file the
 * generated client consumes (`generated.ts`). Pure (no I/O) so it can be unit
 * tested; the CLI entrypoint below wraps it with argv/fetch/write.
 */
export async function generate(asyncApi: AsyncAPIObject): Promise<string> {
    if (!asyncApi.operations)
        throw new Error("No operations found in async api spec");

    if (!asyncApi.channels)
        throw new Error("No channels found in async api spec");

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

    for (const [channelRef, operations] of Object.entries(
        channelsGroupedByRef,
    )) {
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

        const commandMap: Record<string, string> = {};
        const eventMap: Record<string, string> = {};
        const rpcMap: Record<
            string,
            { input: string; output: string; errors: Record<string, string> }
        > = {};
        const serverRpcMap: Record<string, { input: string; output: string }> =
            {};
        const streamMap: Record<string, { input: string; output: string }> = {};

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

            // Stream: action "receive" with a `reply` AND `x-ws-asyncapi-stream`.
            // Checked before the RPC branch because a stream also carries a
            // `reply` and would otherwise be misclassified as an RPC.
            const isStream = "x-ws-asyncapi-stream" in operation;
            if (isStream) {
                const reqRef = operation.messages[0];
                const reply = operation.reply;
                const repRef =
                    reply && "messages" in reply
                        ? reply.messages?.[0]
                        : undefined;
                if (
                    !reqRef ||
                    !("$ref" in reqRef) ||
                    !repRef ||
                    !("$ref" in repRef)
                )
                    continue;
                const input = await compileMessageRef(reqRef.$ref, (name) =>
                    toPascalCase(`${name}StreamInput`),
                );
                const output = await compileMessageRef(repRef.$ref, (name) =>
                    toPascalCase(`${name}StreamOutput`),
                );
                if (input && output)
                    streamMap[input.name] = {
                        input: input.typeName,
                        output: output.typeName,
                    };
                continue;
            }

            // Server→client RPC: action "send" with a `reply`. messages[0] =
            // request (server→client), reply.messages[0] = reply (client→server).
            const isServerRpc = "x-ws-asyncapi-server-rpc" in operation;
            if (isServerRpc) {
                const reqRef = operation.messages[0];
                const reply = operation.reply;
                const repRef =
                    reply && "messages" in reply
                        ? reply.messages?.[0]
                        : undefined;
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
                    reply && "messages" in reply
                        ? reply.messages?.[0]
                        : undefined;
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
                        "x-ws-asyncapi-errors"?: Record<
                            string,
                            { $ref: string }
                        >;
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

        // Auth/presence are channel-level (not operations) — read the schema
        // refs the doc generator attached to the channel and compile them.
        let authTypeName: string | null = null;
        let presenceTypeName: string | null = null;

        const authRef = channel["x-ws-asyncapi-auth"];
        if (authRef && "$ref" in authRef) {
            const compiled = await compileMessageRef(
                authRef.$ref,
                () => "AuthCredentials",
            );
            if (compiled) authTypeName = compiled.typeName;
        }

        const presenceRef = channel["x-ws-asyncapi-presence"];
        if (presenceRef && "$ref" in presenceRef) {
            const compiled = await compileMessageRef(
                presenceRef.$ref,
                () => "PresenceState",
            );
            if (compiled) presenceTypeName = compiled.typeName;
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

        generatedFile.push(
            `export interface StreamMap {
        ${Object.entries(streamMap)
            .map(
                ([key, value]) =>
                    `"${key}": { input: ${value.input}; output: ${value.output} }`,
            )
            .join("\n")}
        }`,
        );

        // `.onAuth` credentials / `.presence` state, when declared. Mirrors the
        // codegen-free `createClient` inference (`undefined` when not declared).
        generatedFile.push(
            `export type AuthCredentials = ${authTypeName ?? "undefined"};`,
        );
        generatedFile.push(
            `export type PresenceState = ${presenceTypeName ?? "undefined"};`,
        );

        generatedFile.push("}");
    }

    const serversRaw = asyncApi.servers
        ? Object.values(asyncApi.servers).filter(
              (server) => "protocol" in server,
          )
        : [];

    const servers = serversRaw.length
        ? serversRaw.map((x) => x.host)
        : ["localhost"];

    const channels = asyncApi.channels
        ? (Object.values(asyncApi.channels).filter(
              (channel) => "address" in channel && channel.address,
              // TODO: remove cast
          ) as ChannelObject[])
        : [];

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
                    .map((channel) => {
                        const ns = toPascalCase(`${channel.title}Channel`);
                        return `"${channel.title}": {
                    query: ${hasInBinding(channel, "query") ? `${ns}.QueryType` : "Record<string, string>"};
                    headers: ${hasInBinding(channel, "headers") ? `${ns}.HeadersType` : "Record<string, string>"};
                    commandMap:  ${ns}.CommandMap;
                    eventMap: ${ns}.EventMap;
                    rpcMap: ${ns}.RpcMap;
                    serverRpcMap: ${ns}.ServerRpcMap;
                    streamMap: ${ns}.StreamMap;
                    authCredentials: ${ns}.AuthCredentials;
                    presenceState: ${ns}.PresenceState;
                }`;
                    })
                    .join("\n")}
            }
        }
    }`);

    return generatedFile.join("\n");
}

// CLI entrypoint: fetch the spec, generate, write `generated.ts`.
if (import.meta.main) {
    const [, , target] = process.argv;

    if (!target)
        throw new Error("Please provide target (http link to async api spec)");

    const response = await fetch(target);
    const asyncApi = (await response.json()) as AsyncAPIObject;

    const output = await generate(asyncApi);
    fs.writeFileSync("generated.ts", output);
}
