<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.9/codex-web-gpt-6.1.9-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.9/codex-web-gpt-6.1.9-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.9/codex-web-gpt-6.1.9-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.9/codex-web-gpt-6.1.9-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">What’s new</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex’s native model picker—with ChatGPT Web’s separate usage limits, without spending your Work or Codex quota. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your Codex task, so you can keep working as the context grows.

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Paid accounts → **GPT-6 Sol** and **GPT-5.6 Sol**, with **Instant–High**, plus **Extra High** and **Pro** when available. Each version has its own entry; existing GPT-5.6 chats keep GPT-5.6. Availability depends on your account and workspace.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models** and restart Codex once. In automatic mode, choose a model ending in **(Web)**. Pro versions have separate entries; Sol reasoning is selected through Effort. Zero Risk keeps its dedicated entry.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `Codex Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic models ending in **(Web)** expose their supported Effort choices in Codex. Instant and each Pro version have separate entries to preserve their context budgets; older saved model entries keep their original fixed mode.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher uses your system proxy for the tunnel. Explicitly configured proxy
environment variables take priority; local connections stay local.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window.
> GPT-5.6 supports up to 270,000 tokens with experimental **3× context** enabled, with native
> Codex compaction supported throughout.
>
> GPT-6 Sol supports Bigger Context at Medium, High and available Extra High: **120,000 tokens
> on Plus**, with compaction at **110,000**, and **240,000 on Pro**, with compaction at **220,000**.
> GPT-6 Instant uses standard context.
> GPT-5.6 and GPT-6 Pro keep their existing Bigger Context limits.

1. Finish the required setup, open **MCP**, create the Tunnel and regular API key, then press
   **Connect harness**.
2. Enable ChatGPT **Developer Mode** and create a new Tunnel connector named exactly
   **Codex Native2**, with **Authentication: None** and **Allow all actions**.
3. Run **Verify runtime** to confirm that **Codex Native2** is attached and available.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings can also cancel a retained browser turn or remove the Codex integration before uninstall.
**Save chats in ChatGPT** keeps task conversations in ChatGPT history. Off by default; independent of **New browser chat for each turn**.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Temporary Chat is a [ChatGPT privacy mode](https://help.openai.com/en/articles/8914046-temporary-chat-faq); prompts are still processed by OpenAI.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Experimental OpenAI-compatible Responses clients (Hermes, Pi, Jcode)</strong></summary>

The local launcher daemon exposes a **Responses-style HTTP interface** on loopback
(`http://127.0.0.1:17841/v1`). This is a bridge to an authenticated ChatGPT **browser session**, not
the official OpenAI API; keep the launcher signed in and running. Start by inspecting the models
your session actually offers:

```bash
curl -fsS http://127.0.0.1:17841/v1/models
```

Choose an `id` from the response's `data` array and substitute it for `MODEL_ID` below.
Unauthenticated discovery (or discovery with a local dummy key) returns the standard OpenAI
`{ "object": "list", "data": [{ "id": "…", "object": "model", … }] }` shape. The existing native
Codex catalog remains available to authenticated Codex clients as `models[].slug`.
The flat aliases are `chatgpt-low`, `chatgpt-medium`, `chatgpt-high`, `chatgpt-xhigh`, and
`chatgpt-pro`. Namespaced alternatives include `chatgpt-web/gpt-6-sol` and
`chatgpt-web/gpt-6-sol-instant`. The bridge maps each public model ID and requested reasoning
effort to a supported browser model and mode; supported efforts and available models depend on
your ChatGPT plan. Do not substitute upstream transport identities such as `gpt-5.6-sol` for
a `chatgpt-…` identifier.

```bash
# Replace this example with an id returned by /v1/models.
MODEL_ID='chatgpt-low'

# Nonstreaming response
curl -fsS http://127.0.0.1:17841/v1/responses \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL_ID}\",\"input\":\"Reply with exactly: bridge ready\",\"stream\":false}"

# Server-sent events (SSE); -N disables curl output buffering
curl -N http://127.0.0.1:17841/v1/responses \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL_ID}\",\"input\":\"Reply with exactly: bridge ready\",\"stream\":true}"
```

The local Responses route does not require an OpenAI platform API key. Some generic clients insist
on an API-key field: use a **dummy local value** where required, never a real account credential.
Generic `/v1/models` discovery needs no upstream authorization. Native Codex clients supplying
their actual Codex Bearer authorization still receive the upstream catalog with local models added;
dummy keys are never forwarded as upstream credentials.
Authentication for the browser session remains managed by the launcher. Do not expose this listener
to other machines: local processes can access it. Separate native image/control endpoints can have
additional authorization requirements.

For other clients, set their **base URL** to `http://127.0.0.1:17841/v1` and use a discovered
`MODEL_ID`. The primary API is **Responses** at `/v1/responses`. A compatibility route at
`/v1/chat/completions` translates standard text, image URLs, and function-tool exchanges for
clients such as Jcode. Clients requiring WebSockets or full OpenAI platform semantics may not work.
Hermes 0.21.5, Pi 1.1.0, and Jcode 0.92.1 have each completed text requests and client-executed
function-tool continuations against an isolated HTTP test server running this bridge's actual
request handlers. This verifies the client wire format. On 2026-10-13, a separate listener built
from the updated source also passed authenticated launcher-browser requests for `chatgpt-low`
(nonstreaming), `chatgpt-medium` (SSE), `chatgpt-web/gpt-6-pro` with the inapplicable `xhigh`
reasoning effort, and a Hermes one-shot. The existing production listener on port 17841 was not
restarted because it still owned an active browser turn. Pi/Jcode browser-backed acceptance and
browser-backed function-tool rounds remain unverified; the isolated client tool-loop tests do
not establish those outcomes.

For Hermes, merge this provider entry into `~/.hermes/config.yaml` (preserve your other providers):

```yaml
providers:
  chatgpt-web:
    base_url: http://127.0.0.1:17841/v1
    api_mode: codex_responses
    discover_models: true
```

Then select the provider and a model that appears in `/v1/models`:

```bash
# Hermes: use the configured Responses provider and allow its terminal tool:
hermes -z 'Reply with exactly: bridge ready' --provider chatgpt-web --model chatgpt-low -t terminal

# Pi: after adding the models.json provider below, run an ephemeral turn:
pi --provider chatgpt-web --model chatgpt-low --print --no-session --no-tools \
  'Reply with exactly: bridge ready'

# Jcode: its named compatible profiles use the Chat Completions translation:
jcode provider add local-chatgpt-web --base-url http://127.0.0.1:17841/v1 \
  --model chatgpt-low --no-api-key
jcode run --provider-profile local-chatgpt-web --tool-profile none \
  'Reply with exactly: bridge ready'
```

For Pi 1.1, merge this provider into `~/.pi/agent/models.json` (preserve existing providers and
select an ID your `/v1/models` discovery returns):

```json
{
  "providers": {
    "chatgpt-web": {
      "baseUrl": "http://127.0.0.1:17841/v1",
      "api": "openai-responses",
      "apiKey": "local-placeholder",
      "models": [
        {
          "id": "chatgpt-low",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 41000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Client-executed function tools require Launcher **Full mode**. Tool results can continue a locally
cached `previous_response_id` or a matching stateless full-transcript function call. The local
response cache is bounded and may expire; it is not an OpenAI platform conversation store.

Hermes, Pi, and Jcode provider configuration can persist local settings; inspect their provider
options before applying them. Do not assume this bridge implements every optional endpoint,
tool schema, conversation feature, or streaming extension that third-party clients expect.
A non-200 generic `/v1/models` response indicates that model discovery is not ready; check whether
the client sent an unrecognized placeholder Bearer key before checking launcher/browser health.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal Codex route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Also by me: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — local, near-real-time custom voices for ChatGPT and Codex.
