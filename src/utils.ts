import type {
    AsyncAPIObject,
    ChannelObject,
    WSBindingObject,
} from "asyncapi-types";

export function toPascalCase(str: string) {
    return str.replace(/(?:^|_|-|:)(\w)/g, (_, char) => char.toUpperCase());
}

export function resolveRef<T>(
    ref: string,
    schema: AsyncAPIObject,
): T | undefined {
    if (!ref.startsWith("#")) return undefined;

    const pointer = ref.slice(1);
    const parts = pointer
        .split("/")
        .filter((part) => part !== "")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

    let current = schema;
    for (const part of parts) {
        if (!current || typeof current !== "object") return undefined;
        // @ts-expect-error
        current = current[part];
    }
    // @ts-expect-error
    return parts.length === 0 ? schema : current;
}

export function addressToType(address: string) {
    return address.replace(/\{.*?\}/g, "${string}");
}

export function hasInBinding<T extends keyof WSBindingObject>(
    channel: ChannelObject,
    key: T,
) {
    return (
        channel.bindings &&
        "ws" in channel.bindings &&
        typeof channel.bindings.ws === "object" &&
        key in channel.bindings.ws
    );
}
