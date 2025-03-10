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

    for (const operation of operations) {
        console.log(operation);
        if (!("messages" in operation) || !operation.messages) continue;

        for (const message of operation.messages) {
            if (!("$ref" in message)) continue;

            console.log(message);
            const messageFromRef = resolveRef<MessageObject>(
                message.$ref,
                asyncApi,
            );
            if (!messageFromRef) {
                console.error(`Message ${message.$ref} not found`);
                continue;
            }
            const [type, schema] = messageFromRef.payload.items;
            const typeName = toPascalCase(
                operation.action === "receive"
                    ? `${type.const}CommandData`
                    : `${type.const}EventData`,
            );

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
            console.log(schema, schemaInterface);
            generatedFile.push(schemaInterface);

            if (operation.action === "receive") {
                commandMap[type.const] = typeName;
            } else {
                eventMap[type.const] = typeName;
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
                }`,
                    )
                    .join("\n")}
            }
        }
    }`);

fs.writeFileSync("generated.ts", generatedFile.join("\n"));
