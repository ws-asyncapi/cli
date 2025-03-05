import fs from "node:fs";
import type { AsyncAPIObject } from "asyncapi-types";
import { compile } from "json-schema-to-typescript";
import { toPascalCase } from "./utils.ts";
console.log(process.argv);

const [_, _2, target] = process.argv;

if (!target)
    throw new Error("Please provide target (http link to async api spec)");

const response = await fetch(target);

const asyncApi = (await response.json()) as AsyncAPIObject;

console.log(asyncApi);

const generatedFile: string[] = [];
const commandMap: Record<string, string> = {};
const eventMap: Record<string, string> = {};

for (const operation of Object.values(asyncApi.operations!)) {
    console.log(operation);
    if (!("messages" in operation) || !operation.messages) continue;

    for (const message of operation.messages) {
        if (!("payload" in message)) continue;

        console.log(message);
        const items = message.payload.items;
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

fs.writeFileSync("generated.ts", generatedFile.join("\n"));
