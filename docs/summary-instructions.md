# Bounded summary instructions and transport gate

`compileSummaryPrompt` prepares separate trusted instructions and untrusted JSON context. It binds the independent response-schema fingerprint and exact pack hash, includes the six display aspects, and accounts for the entire instruction/context payload plus a 1,024-byte framing allowance. The byte proxy is deliberately conservative; it is not a provider tokenizer, billing estimate, hard spend guarantee or remaining quota.

The instructions prohibit tools, filesystem access, DAG/inbox traversal, command execution and delegation. They require included-record citations, historical treatment of approved summaries, and bounded missing-context requests. Source text remains data; it does not modify these rules.

**Instructions alone do not enforce tool isolation.** The result has execution gate `requires-verified-restricted-orca-transport`. No code in this compiler launches Orca, Claude or Codex. A production transport must verify supported agent tool restrictions and bind the requested project scope before sending real context. It must enforce response capture limits separately and budget the provider's real framing overhead once known. No raw vault, inbox archive or private source fixture belongs in this public repository.

The observed Orca interface is terminal-oriented, not a dedicated summary API. Send acceptance, submission and actual turn start are distinct. An idle TUI is not proof of a valid semantic response. Any future ambiguous retry must use the returned retry request identity and the same payload/process incarnation; it must not silently send a second prompt. This implementation has not exercised those operations.

The selected strategy is existing Orca CLI agents. The current application remains in explicit sample/disabled mode while these transport and local configuration boundaries are integrated. No external vendor API or credentials were introduced.
