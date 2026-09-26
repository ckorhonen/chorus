# Chorus — Codex instructions

## Map and conventions

`src/ui/components/` and `src/ui/App.tsx` implement React UI; `src/core/chorus/` holds provider, query, and SQLite access logic; `src-tauri/src/` holds the native Rust layer and migrations. `SCHEMA.md` is the checked-in schema reference. Account/billing/proxy service code lives outside this repository.

Retain the conventions in `AGENT.md`/`CLAUDE.md`: strict TypeScript, handled promises, `@ui/*`/`@core/*` aliases, PascalCase components, I-prefixed interfaces, and the existing date/null conversions. Avoid adding database foreign-key constraints; coordinate migrations, data types, database access, and query mutations. Existing restrictions on `setTimeout`, `useImperativeHandle`, `useRef`, and type assertions are project preferences that need a focused discussion if the change depends on an exception.

## Development and checks

Use pnpm 9 and Node 22 to match CI (manifest minimum Node 20), plus Rust/Cargo and macOS native build tools for Tauri. `pnpm install --frozen-lockfile` installs JS dependencies; Git LFS assets may be needed for native builds. `pnpm run vite:dev` starts the web UI, while `pnpm run dev -- <instance-name>` starts the Tauri development instance. `pnpm run setup` also copies existing authentication and chat data into that instance; don't use it as a harmless install shortcut. Use isolated data for runtime checks, and avoid `delete-db`, QA/prod launches, or release scripts unless their effects are in scope.

Run `pnpm run lint`, `pnpm run format:check`, `pnpm run build` (TypeScript plus Vite), and `pnpm exec vitest run` for the affected frontend behavior. Rust changes need the applicable Cargo check/tests under `src-tauri/`, with native prerequisites installed. Inspect changed native interactions in the running development app when available; distinguish missing desktop/provider access from checks that can still run.

For Codex, this guide replaces `CLAUDE.md`'s blanket assumption that only the user can test and its automatic pause after every fix. Run available checks yourself, preserve dirty work instead of automatically checking out/pulling main, and request user verification only for a concrete inaccessible behavior. Never log complete provider payloads or private chats as troubleshooting output.

## Finishing work

Follow the nearby implementation and keep changes within the requested scope. Carry authorized changes through the relevant checks, fixing failures caused by the change. For a bug, reproduce the affected behavior and add a focused regression check when useful. Make routine reversible choices without another approval; ask only when missing information materially changes correctness, scope, or authorization, and name the exact source of any blocking rule. Report what changed, checks actually run, and concrete unverified behavior; repeat checks when new edits or evidence warrant it.
