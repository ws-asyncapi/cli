import { describe, expect, it } from "bun:test";
import type { AsyncAPIObject } from "asyncapi-types";
import { resolveRef } from "../src/utils.ts";

describe("resolveRef", () => {
    const mockSchema = {
        "x-ws-asyncapi": true,
        asyncapi: "3.0.0",
        info: {
            title: "AsyncAPI",
            version: "1.0.0",
            description: "AsyncAPI",
        },
        servers: {},
        channels: {
            test: {
                address: "/test/{id}",
                bindings: {
                    ws: {
                        bindingVersion: "0.1.0",
                    },
                },
                messages: {
                    ResponseSend: {
                        payload: {
                            type: "array",
                            items: [
                                {
                                    const: "response",
                                    type: "string",
                                },
                                {
                                    type: "object",
                                    properties: {
                                        name: {
                                            type: "array",
                                            items: [
                                                {
                                                    type: "string",
                                                },
                                                {
                                                    type: "number",
                                                },
                                            ],
                                            additionalItems: false,
                                            minItems: 2,
                                            maxItems: 2,
                                        },
                                    },
                                    required: ["name"],
                                },
                            ],
                            additionalItems: false,
                            minItems: 2,
                            maxItems: 2,
                        },
                    },
                    TestReceive: {
                        payload: {
                            type: "array",
                            items: [
                                {
                                    const: "test",
                                    type: "string",
                                },
                                {
                                    type: "object",
                                    properties: {
                                        name: {
                                            type: "string",
                                        },
                                    },
                                    required: ["name"],
                                },
                            ],
                            additionalItems: false,
                            minItems: 2,
                            maxItems: 2,
                        },
                    },
                },
                parameters: {
                    id: {},
                },
            },
        },
        components: {},
        operations: {
            TestResponse: {
                action: "send",
                channel: {
                    $ref: "#/channels/test",
                },
                messages: [
                    {
                        $ref: "#/channels/test/messages/ResponseSend",
                    },
                ],
                "x-ws-asyncapi-operation": 1,
            },
            TestTest: {
                action: "receive",
                channel: {
                    $ref: "#/channels/test",
                },
                messages: [
                    {
                        $ref: "#/channels/test/messages/TestReceive",
                    },
                ],
                "x-ws-asyncapi-operation": 1,
            },
        },
    } satisfies AsyncAPIObject;

    it("should resolve existing message reference", () => {
        const result = resolveRef(
            "#/channels/test/messages/TestReceive",
            mockSchema,
        );

        expect(result).toEqual(mockSchema.channels.test.messages.TestReceive);
    });

    it("should return undefined for non-existent path", () => {
        const result = resolveRef("#/channels/invalid/path", mockSchema);
        expect(result).toBeUndefined();
    });

    it("should handle JSON pointer escaped characters", () => {
        const result = resolveRef(
            "#/channels/test/messages/TestReceive",
            mockSchema,
        );

        expect(result).toEqual(mockSchema.channels.test.messages.TestReceive);
    });

    it("should return undefined for empty reference", () => {
        const result = resolveRef("", mockSchema);
        expect(result).toBeUndefined();
    });

    it("should resolve root document for # reference", () => {
        const result = resolveRef("#", mockSchema);
        expect(result).toEqual(mockSchema);
    });

    it("should return undefined for invalid reference format", () => {
        const result = resolveRef("invalid#/reference", mockSchema);
        expect(result).toBeUndefined();
    });
});
