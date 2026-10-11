import {createDemoSnapshot,createEmptySnapshot,retainLastGoodSnapshot} from '../domain';
import type {WorkspaceSnapshot} from '../domain';
import type {DemoScenario} from './security';
export class DemoStore {
  private lastGood:WorkspaceSnapshot|null=null;
  read(scenario:DemoScenario):WorkspaceSnapshot {
    if(scenario==='failure') {
      if(!this.lastGood) throw new Error('No previous observation is available');
      const attemptedAt=new Date(Math.max(Date.now(),Date.parse(this.lastGood.observedAt)+1)).toISOString();
      return retainLastGoodSnapshot(this.lastGood,attemptedAt,'가상 갱신 실패입니다. 마지막 성공 내용을 유지하며 실제 Orca 명령은 실행하지 않았습니다.');
    }
    const snapshot=scenario==='empty'?createEmptySnapshot():createDemoSnapshot();
    this.lastGood=snapshot;
    return structuredClone(snapshot);
  }
  clear():void {this.lastGood=null;}
}
