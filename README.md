# @myraildepot/local-bridge

A small server that runs on your own computer and connects your Z21 DCC command station to
[MyRailDepot](https://myraildepot.com). It talks to your command station over your local network and
relays commands from the MyRailDepot app to your layout.

## Install

```sh
npx @myraildepot/local-bridge <TOKEN>
```

Get a token from the "Declare a bridge" screen in MyRailDepot — it's valid for a short time and can only
be used once. The bridge exchanges it for real credentials and stores them in a local `.env` file next to
wherever you ran the command.

Once installed, start it again any time with:

```sh
npx @myraildepot/local-bridge
```

A friendlier guided installer (with per-OS instructions) is coming soon.

## Local development

```sh
pnpm install
pnpm dev
```

Other useful scripts: `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.

## License

MIT — see [LICENSE](./LICENSE).
