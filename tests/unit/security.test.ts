import {describe,it,expect} from 'vitest';
import {parseDemoRequest,assertNoArguments,assertTrustedSender} from '../../src/main/security';
describe('narrow request validation',()=>{
  it('allows only declared fixture scenarios',()=>{expect(parseDemoRequest({scenario:'normal'})).toEqual({scenario:'normal'});});
  it.each([null,[],{},'normal',{scenario:'normal',path:'/tmp'},{scenario:'../../secret'},{scenario:'failure',command:'sh'}])('rejects invalid input %j',input=>{expect(()=>parseDemoRequest(input)).toThrow();});
  it('rejects arguments on parameterless channel',()=>{expect(()=>assertNoArguments(['path'])).toThrow();});
  it('rejects unknown sender, subframes, and non-app URLs',()=>{
    const frame={url:'file:///app/index.html#/settings'};
    const owner={mainFrame:frame};
    expect(()=>assertTrustedSender({sender:owner,senderFrame:frame} as never,owner as never,'file:///app/index.html')).not.toThrow();
    expect(()=>assertTrustedSender({sender:{},senderFrame:frame} as never,owner as never,'file:///app/index.html')).toThrow();
    expect(()=>assertTrustedSender({sender:owner,senderFrame:{...frame}} as never,owner as never,'file:///app/index.html')).toThrow();
    expect(()=>assertTrustedSender({sender:owner,senderFrame:frame} as never,owner as never,'file:///other/index.html')).toThrow();
  });
});
