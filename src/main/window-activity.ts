/** Native events are the activity authority. On macOS, isFocused/isVisible can
 * still report the prior value inside a focus/show callback. Re-reading those
 * values in every callback can misclassify foreground/background after a resume.
 */
type ActivityEvent = 'show' | 'hide' | 'focus' | 'blur' | 'minimize' | 'restore';
interface ActivityWindow {
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  on(event: ActivityEvent, listener: () => void): unknown;
}
export function observeWindowActivity(window: ActivityWindow, publish: (activity: {visible:boolean; active:boolean})=>void): void {
  let shown=window.isVisible(), minimized=window.isMinimized(), active=window.isFocused();
  const update=()=>publish({visible:shown&&!minimized,active});
  window.on('focus',()=>{active=true;update();});
  window.on('blur',()=>{active=false;update();});
  window.on('show',()=>{shown=true;update();});
  window.on('hide',()=>{shown=false;active=false;update();});
  window.on('minimize',()=>{minimized=true;active=false;update();});
  window.on('restore',()=>{minimized=false;update();});
  update();
}
