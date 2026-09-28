![jevgrep — Same intelligence. About 30% lower cost.](assets/cover.png)

# jevgrep

[![npm](https://img.shields.io/npm/v/@dzhng/jevgrep?style=flat-square&color=ef5638)](https://www.npmjs.com/package/@dzhng/jevgrep)
[![MIT license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square)](apps/cli/README.md)
[![Release](https://img.shields.io/github/actions/workflow/status/dzhng/jevgrep/publish.yml?style=flat-square&label=release)](https://github.com/dzhng/jevgrep/actions/workflows/publish.yml)

**Same intelligence. ~30% lower cost.**

`jevgrep` (`jg`) is a **Semantic Code Intelligence Suite** and fast source retriever built for AI coding agents and developers. Powered by TypeSafe's calibrated System One model [Jev](https://vercel.com/ai-gateway/models/jev), `jg` turns natural-language questions, stack traces, and symbol names into precise, high-confidence source context and calibrated probabilistic judgments.

| Command | Capability | Typical Use Case |
| :--- | :--- | :--- |
| **`jg "question"`** | **Semantic Code Search** | Unfamiliar codebase exploration & source retrieval |
| **`jg diagnose`** | **Root-Cause Bug Locator** | Pinpoint culprit declarations from stack traces (Node, Python, PHP, Laravel) |
| **`jg impact`** | **Semantic Blast Radius** | Predict breaking changes & contract compatibility across callers |
| **`jg guard`** | **Security & Policy Guard** | Audit credential leaks, injection risks & architecture violations |

```sh
npm install -g @dzhng/jevgrep
jg auth
jg skill
jg "How are telemetry events recorded and sent?" ./my-project
```

Requires **Node.js 22+**, **Windows, macOS, or Linux**, and an API key for **OpenRouter, TypeSafe, Vercel AI Gateway, or OpenCode Zen**.
No separate Python, Bun, or ripgrep installation is required to use `jg`.

## Install the agent skill — required for agent setup

Installing the CLI alone does not teach your coding agent to use it. **Install
the skill as well**, from the project where your agent works:

```sh
jg skill
```

The installer detects your coding agents (Claude Code, Codex, OpenCode and
others) and asks where to install. Add `--global` for a user-wide install, or
`--yes` for unattended installation. The
[skill](skills/jevgrep/SKILL.md) explains installation, invocation and the meaning of returned context.
It leaves research and implementation decisions to the calling agent. The current repository skill
checks for `jg` and installs the CLI if it is missing; authentication still needs
your selected provider’s key. The skill installer itself does not configure credentials.

`jg skill` delegates to the [skills CLI](https://github.com/vercel-labs/skills)
and needs npm/npx plus network access. You can also run that installer directly,
without the CLI installed:

```sh
npx skills add dzhng/jevgrep --skill jevgrep
```

In 0.1.0, `jg skill` only prints the bundled skill; use `npx skills` with that version.

### Upgrade

There is currently no `jg upgrade` command. Upgrade the CLI with npm:

```sh
npm install -g @dzhng/jevgrep@latest
jg --version
```

Update the installed skill separately by rerunning `jg skill`. Updating the npm package does not
overwrite skill files in your projects. See the [package guide](apps/cli/README.md)
for authentication details.

## Start with a question, leave with source

Use `jg` when you know the behavior you need to understand but not where it lives:

```sh
jg "Where is authentication checked before a request reaches a handler?" .
jg "How are database connections created, pooled, and closed?" ./src
jg "Which tests cover retry behavior when a request times out?" .
```

Jevgrep explores the repository hierarchy and follows qualifying branches. It
selects files using content previews, then identifies useful source units and
surrounding context. It keeps qualifying file locations even when it cannot
confidently return an excerpt; it does not force every search into a fixed top-two
list.

The summary and compact file list come first, followed by selected source with
line references, then detailed declaration and call locations. Python and TypeScript/JavaScript support declaration
parsing; other text uses a fallback. The output is evidence for the agent to use,
not a generated answer or a guarantee that every relevant file was found.
[See a recorded output example](specs/done/jevgrep/assets/stdout-example.txt).

When you already know an exact symbol or path, a direct read or `rg` search may be
all you need. Jevgrep is most useful for questions that span unfamiliar files.

## Semantic Code Intelligence Suite

Beyond exploratory search, `jg` provides dedicated primitives for debugging, refactoring, and quality gates:

### Diagnose: Root-Cause Bug Locator

Pass a stack trace, test error, or crash log (supports Python, Node.js V8, PHP, and Laravel Ignition):

```sh
jg diagnose "TypeError: Cannot read properties of undefined at parseCommand (args.ts:45:12)" .
```

`jg diagnose` parses frames across your repository, extracts surrounding declarations, and evaluates calibrated probabilities distinguishing the root-cause bug from downstream secondary symptoms.

### Impact: Semantic Blast Radius Analyzer

Assess risks and breaking changes before modifying a shared function, class, or contract:

```sh
jg impact "parseCommand" . --description "Changing argument order and adding required fields"
```

Finds all callers and consumers across the codebase and predicts breaking change probability, behavioral divergence, and backward compatibility.

### Guard: Semantic Architecture & Security Audit

Run calibrated policy checks against code to detect vulnerabilities and architectural leaks:

```sh
jg guard . --threshold 0.70
jg guard . --file "apps/api/src/routes/auth.ts"
```

Audits against credential leakage, unsanitized query/command injection, architectural layer boundary violations, and silent error swallows. Exits with code `2` if violations are found, making it ideal for CI/CD gates and pre-commit checks.

## What we measured

**Same intelligence, ~30% lower coding-agent cost.** Both
Jevgrep and the no-Jev baseline solved **8/10 tasks**. Full Sol cost fell from
**$7.62 to $5.44**—a measured **28.6% reduction**, rounded to ~30%—including failed
attempts and excluding Jev cost.

![Jevgrep workflow: about 30% lower coding-agent cost, with 8 of 10 tasks solved both with and without Jevgrep.](assets/how-it-works.png)

This comparison uses ten tuned Python SWE-bench tasks, one frozen installed
package and the exact public skill in this repository. It measures task success
and cost, not a speed improvement or guaranteed savings on every repository.
See the [results and methodology](evals/results/relevance-threshold-2026-09-27.md)
for per-task costs, artifact identities and limitations.

## Source, credentials, and local state

Searches send eligible source content to Jev through the provider selected during auth. Default
filesystem filtering respects ignore files and excludes hidden, dependency/build,
binary, and obvious credential files. These filters are not a guarantee that all
sensitive information has been removed; choose a search root you intend to send.

`jg auth` asks for your provider, then saves its key in an owner-only config file.
Re-running auth replaces that setup; searches always use the saved provider.
`jg doctor` checks it with synthetic input. Existing saved keys without a provider
remain Vercel keys. Environment-based credentials and endpoint overrides are not
used; run `jg auth` if you previously relied on them.
Evaluation answers are cached locally by default. The CLI writes its output to
stdout and does not create report files. Use `jg --help` for cache controls,
search overrides, and incomplete-result behavior.

## Development

The repository uses TypeScript, Bun workspaces, and Turborepo. From a checkout:

```sh
bun install --frozen-lockfile
bun run dev --help
bun run verify
```

Verification includes Docker tests of the installed Node-only package. For the
reasoning behind retrieval, parsing, caching, and failure handling, start with the
[architecture](docs/architecture.md) and [implementation record](specs/done/jevgrep/README.md).
[Release guidance](scripts/RELEASING.md) covers tag-triggered npm publication and
verification of the exact public package.

[MIT](LICENSE). [Artwork and generation prompts](assets/README.md).
