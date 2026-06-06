# @ws-asyncapi/cli

[![npm](https://img.shields.io/npm/v/@ws-asyncapi/cli?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@ws-asyncapi/cli)
[![npm downloads](https://img.shields.io/npm/dw/@ws-asyncapi/cli?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@ws-asyncapi/cli)

Codegen CLI for **ws-asyncapi** — turn a channel's **AsyncAPI 3.0** document into a
fully-typed client.

In a monorepo you don't need this: `createClient<typeof channel>()` infers the whole
client surface straight from the channel's type, no build step. Reach for the CLI
when client and server live in **separate repos**, when the consumer isn't
TypeScript, or when you publish the contract as a language-agnostic AsyncAPI
document.

## Usage

Point it at a running server's AsyncAPI document (every adapter can serve one via
`getAsyncApiDocument`):

```bash
bunx @ws-asyncapi/cli http://localhost:3000/asyncapi.json
# writes generated.ts to the current directory
```

`generated.ts` is a `declare module "@ws-asyncapi/client"` augmentation. Import it
once, then use the address-based factory — its typed surface matches
`createClient`:

```ts
import "./generated"; // registers the channel types
import { websocketAsyncAPI } from "@ws-asyncapi/client";

const client = websocketAsyncAPI("ws://localhost:3000", "/chat/general");
// onEvent, call, request, safeRequest, stream, authenticate, presence, history
```

The generated client covers the **full** contract — events, commands, RPC (with
typed errors), server-RPC, streams, auth credentials, and presence state.

## Programmatic API

The generator is pure (no I/O), so you can run it in your own build:

```ts
import { generate } from "@ws-asyncapi/cli";
import { writeFileSync } from "node:fs";

const doc = await fetch("http://localhost:3000/asyncapi.json").then((r) => r.json());
writeFileSync("generated.ts", await generate(doc));
```

- `generate(asyncApi: AsyncAPIObject): Promise<string>` — returns the `generated.ts`
  source for the given AsyncAPI 3.0 document.

## License

MIT
