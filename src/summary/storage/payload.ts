import { parseSummaryStoreState, type SummaryStoreState } from '../claims';
import { validateProjectionContext, type ProjectionContext } from '../context/projection';
import { SummaryCacheError, MAX_SUMMARY_CACHE_BYTES } from './index';
import { copyBoundedCacheData } from './data';

/** Local-only manifest. Never append this cache payload to prompts or renderer IPC. */
export interface SummaryCachePayload { state: SummaryStoreState; projectionContexts: ProjectionContext[] }
export const summaryCacheCodec = {
  parse(value: unknown): SummaryCachePayload {
    value = copyBoundedCacheData(value, MAX_SUMMARY_CACHE_BYTES);
    const fail = (): never => { throw new SummaryCacheError('invalid', 'Invalid local projection persistence payload'); };
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'state') || !Object.hasOwn(value, 'projectionContexts')) fail();
    const v = value as SummaryCachePayload;
    const state = parseSummaryStoreState(v.state);
    if (!Array.isArray(v.projectionContexts) || v.projectionContexts.length > 97) fail();
    const projectionContexts = v.projectionContexts.map(validateProjectionContext);
    const scopeId = state.packs[0].scopeId;
    const seen = new Set<string>();
    for (const context of projectionContexts) {
      const fingerprint = JSON.stringify(context);
      if (seen.has(fingerprint) || context.input.scopeId !== scopeId || !context.provenance.entries.length
        || !context.input.records.every(entry => state.packs.some(pack => pack.sources.some(source => source.sourceId === entry.sourceId && source.sourceHash === entry.sourceHash)))) fail();
      seen.add(fingerprint);
    }
    for (const pack of state.packs) {
      for (const record of pack.records.filter(r => r.sourceId.startsWith('projection-v1-') || r.sourceId.startsWith('registered-v1-'))) {
        if (!projectionContexts.some(context => context.input.scopeId === pack.scopeId && context.input.records.some(r => JSON.stringify(r) === JSON.stringify(record)))) fail();
      }
    }
    return structuredClone({ state, projectionContexts });
  },
};
