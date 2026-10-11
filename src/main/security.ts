import type { IpcMainInvokeEvent, WebContents } from 'electron';
export function assertTrustedSender(event: IpcMainInvokeEvent, owner: WebContents, entryUrl: string): void {
  if (event.sender !== owner || event.senderFrame !== owner.mainFrame || event.senderFrame?.url.split('#')[0] !== entryUrl) throw new Error('Untrusted IPC sender');
}
export function assertNoArguments(args: unknown[]): void {
  if(args.length !== 0) throw new Error('This request accepts no arguments');
}
export const DEMO_SCENARIOS = ['normal','empty','failure'] as const;
export type DemoScenario = typeof DEMO_SCENARIOS[number];
export function parseDemoRequest(input: unknown): {scenario:DemoScenario} {
  if(!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid demo request');
  const candidate = input as Record<string, unknown>;
  if(Object.keys(candidate).length !== 1 || !DEMO_SCENARIOS.includes(candidate.scenario as DemoScenario)) throw new Error('Invalid demo scenario');
  return {scenario:candidate.scenario as DemoScenario};
}
