import fs from "node:fs";
import type { AsyncAPIObject, MessageObject } from "asyncapi-types";
import { compile } from "json-schema-to-typescript";
import { resolveRef, toPascalCase } from "./utils.ts";

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
const commandMap: Record<string, string> = {};
const eventMap: Record<string, string> = {};

for (const operation of Object.values(asyncApi.operations)) {
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
        const items = messageFromRef.payload.items;
        const typeName = toPascalCase(
            operation.action === "receive"
                ? `${items[0].const}CommandData`
                : `${items[0].const}EventData`,
        );

        const schema = await compile(
            { additionalProperties: false, ...items[1] },
            typeName,
            {
                bannerComment: "",
                additionalProperties: false,
            },
        );
        console.log(schema);
        generatedFile.push(schema);

        if (operation.action === "receive") {
            commandMap[items[0].const] = typeName;
        } else {
            eventMap[items[0].const] = typeName;
        }
    }
}

if (Object.keys(commandMap).length)
    generatedFile.push(
        `export interface CommandMap {
    ${Object.entries(commandMap)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n")}
    }`,
    );

if (Object.keys(eventMap).length)
    generatedFile.push(
        `export interface EventMap {
    ${Object.entries(eventMap)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n")}
    }`,
    );

const serversRaw = asyncApi.servers
    ? Object.values(asyncApi.servers).filter((server) => "protocol" in server)
    : [];

const servers = serversRaw.length
    ? serversRaw.map((x) => x.host)
    : [new URL(target).host];

// console.log(servers);

const channels = asyncApi.channels
    ? Object.values(asyncApi.channels).filter(
          (channel) => "address" in channel && channel.address,
      )
    : [];

// console.log(channels);

// TODO: Подумать с точки зрения каналов
generatedFile.push(
    "export interface WebsocketServers {",
    `${servers.map((x) => `"${x}": string`).join("\n")}`,
    "}",
);

generatedFile.push(`declare module "@ws-asyncapi/client" {
        export interface WebsocketAsyncAPIMap {
            data: {
                commandMap: CommandMap;
                eventMap: EventMap;
            }
        }
    }`);

fs.writeFileSync("generated.ts", generatedFile.join("\n"));
