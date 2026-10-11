import type { Workstream, WorkspaceSnapshot } from './types';
import { parseFixtureSnapshot } from './validation';

export type SummaryBackendMode = 'disabled' | 'manual-fixture';
export interface SummaryRequest {
  snapshot: WorkspaceSnapshot;
  workstreamId: string;
}
export type SummaryResult =
  | { state: 'disabled'; reason: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'manual-fixture'; workstreamId: string; goal: Workstream['goal']; summary: Workstream['summary'] };

/** No endpoint, API token, model loader, Orca agent or transport is configurable. */
export interface SummaryBackend {
  readonly mode: SummaryBackendMode;
  summarize(request: SummaryRequest): Promise<SummaryResult>;
}

export function createSummaryBackend(mode: SummaryBackendMode = 'disabled'): SummaryBackend {
  if (mode !== 'disabled' && mode !== 'manual-fixture') throw new Error('Unsupported summary backend mode');
  return {
    mode,
    async summarize(request): Promise<SummaryResult> {
      if (mode === 'disabled') {
        return { state: 'disabled', reason: 'Orca 에이전트 요약 연결은 아직 준비 중입니다. 컨텍스트 제한·예산 확인·실행 연결 검증 전에는 자동 요약을 실행하지 않습니다.' };
      }
      const snapshot = parseFixtureSnapshot(request.snapshot);
      const stream = snapshot.workstreams.find((item) => item.id === request.workstreamId);
      if (!stream) return { state: 'unavailable', reason: '이 가상 관측에는 요청한 작업 흐름이 없습니다.' };
      return { state: 'manual-fixture', workstreamId: stream.id, goal: stream.goal, summary: stream.summary };
    },
  };
}
