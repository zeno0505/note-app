import {describe,it,expect} from 'vitest';
import {EventEmitter} from 'node:events';
import {observeWindowActivity} from '../../src/main/window-activity';

describe('native window activity authority',()=>{
  it('resumes from focus/show events even when synchronous native snapshots lag',()=>{
    const window=Object.assign(new EventEmitter(),{isVisible:()=>false,isFocused:()=>false,isMinimized:()=>false});
    const states:{visible:boolean;active:boolean}[]=[];observeWindowActivity(window,s=>states.push(s));
    expect(states.at(-1)).toEqual({visible:false,active:false});
    window.emit('focus');window.emit('show');expect(states.at(-1)).toEqual({visible:true,active:true});
    window.emit('blur');expect(states.at(-1)).toEqual({visible:true,active:false});
    window.emit('focus');expect(states.at(-1)).toEqual({visible:true,active:true});
  });
  it('pauses immediately for hide/minimize despite stale true snapshots, and requires focus again',()=>{
    const window=Object.assign(new EventEmitter(),{isVisible:()=>true,isFocused:()=>true,isMinimized:()=>false});
    const states:{visible:boolean;active:boolean}[]=[];observeWindowActivity(window,s=>states.push(s));
    window.emit('hide');expect(states.at(-1)).toEqual({visible:false,active:false});
    window.emit('show');expect(states.at(-1)).toEqual({visible:true,active:false});
    window.emit('focus');expect(states.at(-1)).toEqual({visible:true,active:true});
    window.emit('minimize');expect(states.at(-1)).toEqual({visible:false,active:false});
    window.emit('restore');expect(states.at(-1)).toEqual({visible:true,active:false});
    window.emit('focus');expect(states.at(-1)).toEqual({visible:true,active:true});
  });
});
