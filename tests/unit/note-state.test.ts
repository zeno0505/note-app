import {it,expect} from 'vitest';
import {noteState} from '../../src/renderer/note-state';
import type {LiveWorkstreamView,LiveWorkspaceView,LiveDagView} from '../../src/shared/live';
const workstream={noteMapping:{state:'resolved',reason:null,dagId:'one'},project:{status:'active',sourceState:'available'}} as LiveWorkstreamView;
const live={connection:'connected',freshness:'current',refreshing:false} as LiveWorkspaceView;
const dag={state:'ready'} as LiveDagView;
it('distinguishes disconnected, stale, missing registration, permission, query failure and current source',()=>{
 expect(noteState(workstream,{...live,connection:'disconnected'},dag).label).toBe('노트 연결 미확인');
 expect(noteState(workstream,{...live,freshness:'stale'},dag).label).toBe('노트 연결 관측 오래됨');
 expect(noteState({...workstream,noteMapping:{state:'unresolved',dagId:null,reason:'dag-not-registered'}},live).label).toBe('등록된 DAG 없음');
 expect(noteState({...workstream,noteMapping:{state:'unresolved',dagId:null,reason:'note-outside-scope'}},live).label).toBe('허용된 노트 범위 밖');
 expect(noteState(workstream,live,{...dag,state:'error'}).label).toBe('노트 연결 확인 · DAG 조회 실패');
 expect(noteState({...workstream,project:{...workstream.project!,sourceState:'not-checked'}},live,dag).label).toBe('노트 현재 접근 미확인');
 expect(noteState(workstream,live,dag).block).toBeNull();
});
it('shows actual retirement cause before stale guidance and allows refresh only when cleanup was verified',()=>{
 for(const cleanup of ['pending','unverified','verified'] as const){const result=noteState(workstream,{...live,freshness:'stale'},{...dag,state:'error',readerRecovery:{cause:'timeout',cleanup,retired:true,generation:0}});expect(result.label).toContain('timeout');expect(result.block).toContain(cleanup==='verified'?'안전하게 다시 조회':'겹치는 조회를 시작하지 않습니다');}
});
