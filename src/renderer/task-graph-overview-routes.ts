import type {GraphGroupLink} from '../shared/task-graph-contract';
export interface OverviewCard {key:string;x:number;y:number}
export interface OverviewRoute extends GraphGroupLink {path:string;x:number;y:number;reverse:boolean;points:readonly {x:number;y:number}[]}
const WIDTH=300,HEIGHT=164,COLUMN_GAP=120,ROW_GAP=136;
type Side='left'|'right'|'top'|'bottom';
/** Grid-card routing, independent of private group names and aggregate cycles.
 * Every endpoint owns a distinct port. Non-neighbor routes use gaps, never a
 * card interior. Shared row gaps and detour columns receive distinct tracks.
 * Perpendicular crossings remain possible; this is not a crossing-free layout. */
export function routeOverviewGroups(cards:readonly OverviewCard[],links:readonly GraphGroupLink[]):OverviewRoute[]{
 const byKey=new Map(cards.map(card=>[card.key,card]));
 const plans=[...links].sort((a,b)=>{const ak=JSON.stringify([a.fromGroupKey,a.toGroupKey]),bk=JSON.stringify([b.fromGroupKey,b.toGroupKey]);return ak<bk?-1:ak>bk?1:0;}).map(link=>{const a=byKey.get(link.fromGroupKey),b=byKey.get(link.toGroupKey);if(!a||!b)throw Error('missing-group');
  const horizontal=a.y===b.y&&Math.abs(a.x-b.x)===WIDTH+COLUMN_GAP;
  const vertical=Math.abs(a.y-b.y)===HEIGHT+ROW_GAP;
  const from:Side=horizontal?(a.x<b.x?'right':'left'):vertical?(a.y<b.y?'bottom':'top'):'right';
  const to:Side=horizontal?(a.x<b.x?'left':'right'):vertical?(a.y<b.y?'top':'bottom'):'left';
  return {link,a,b,horizontal,vertical,from,to};});
 const ports=new Map<string,number[]>();
 plans.forEach((plan,index)=>{for(const [card,side]of [[plan.a,plan.from],[plan.b,plan.to]] as const){const key=JSON.stringify([card.key,side]);const slots=ports.get(key)??[];slots.push(index);ports.set(key,slots);}});
 function port(card:OverviewCard,side:Side,index:number){const slots=ports.get(JSON.stringify([card.key,side]))!,fraction=(slots.indexOf(index)+1)/(slots.length+1);return side==='left'||side==='right'?{x:card.x+(side==='right'?WIDTH:0),y:card.y+HEIGHT*fraction}:{x:card.x+WIDTH*fraction,y:card.y+(side==='bottom'?HEIGHT:0)};}
 // Allocate gap tracks from stable link identities, not caller iteration order.
 const rowTracks=new Map<number,number[]>(),columnTracks=new Map<number,string[]>();
 plans.forEach((plan,index)=>{
  if(plan.horizontal)return;
  const row=plan.vertical?Math.min(plan.a.y,plan.b.y):plan.a.y;
  rowTracks.set(row,[...(rowTracks.get(row)??[]),index]);
  if(!plan.vertical)for(const [x,key] of [[plan.a.x+WIDTH,`${index}:from`],[plan.b.x-COLUMN_GAP,`${index}:to`]] as const)columnTracks.set(x,[...(columnTracks.get(x)??[]),key]);
 });
 function rowLane(row:number,index:number){const slots=rowTracks.get(row)!;return row+HEIGHT+20+(ROW_GAP-40)*(slots.indexOf(index)+1)/(slots.length+1);}
 function columnLane(x:number,key:string){const slots=columnTracks.get(x)!;const left=Math.max(8,x+20),right=x+COLUMN_GAP-20;return left+(right-left)*(slots.indexOf(key)+1)/(slots.length+1);}
 return plans.map((plan,index)=>{const {link,a,b,from,to,horizontal,vertical}=plan,start=port(a,from,index),end=port(b,to,index);
  let points:{x:number;y:number}[];
  if(horizontal)points=[start,end];
  else if(vertical){const mid=rowLane(Math.min(a.y,b.y),index);points=[start,{x:start.x,y:mid},{x:end.x,y:mid},end];}
  else {const sx=columnLane(a.x+WIDTH,`${index}:from`),ex=columnLane(b.x-COLUMN_GAP,`${index}:to`),y=rowLane(a.y,index);points=[start,{x:sx,y:start.y},{x:sx,y},{x:ex,y},{x:ex,y:end.y},end];}
  // Label the longest horizontal segment. Text is kept out of card interiors.
  let label={x:(start.x+end.x)/2,y:(start.y+end.y)/2},longest=-1;
  for(let i=1;i<points.length;i++)if(points[i].y===points[i-1].y&&Math.abs(points[i].x-points[i-1].x)>longest){longest=Math.abs(points[i].x-points[i-1].x);label={x:(points[i].x+points[i-1].x)/2,y:points[i].y};}
  return {...link,path:points.map((point,i)=>`${i?'L':'M'} ${point.x} ${point.y}`).join(' '),...label,reverse:a.y>b.y||(a.y===b.y&&a.x>b.x),points};
 });
}
/** Keep route/count annotations above the dedicated bottom legend band. */
export function overviewBoardHeight(cards:readonly OverviewCard[],routes:readonly OverviewRoute[]):number{
 let height=Math.max(320,Math.ceil(cards.length/3)*300);
 for(const route of routes)for(const point of route.points)height=Math.max(height,point.y+60);
 return height;
}
