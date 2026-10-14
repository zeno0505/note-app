import {describe,it,expect} from 'vitest';
import {routeOverviewGroups,overviewBoardHeight,type OverviewCard} from '../../src/renderer/task-graph-overview-routes';
import type {GraphGroupLink} from '../../src/shared/task-graph-contract';
const cards:OverviewCard[]=Array.from({length:9},(_,i)=>({key:String(i),x:48+i%3*420,y:60+Math.floor(i/3)*300}));
const link=(a:number,b:number):GraphGroupLink=>({fromGroupKey:String(a),toGroupKey:String(b),uniqueEdgeCount:1,semantics:'aggregate-only'});
function crossesCard(a:{x:number;y:number},b:{x:number;y:number},card:OverviewCard){return a.y===b.y?a.y>card.y&&a.y<card.y+164&&Math.max(a.x,b.x)>card.x&&Math.min(a.x,b.x)<card.x+300:a.x>card.x&&a.x<card.x+300&&Math.max(a.y,b.y)>card.y&&Math.min(a.y,b.y)<card.y+164;}
describe('overview group routing (geometry only, not pixels)',()=>{
 it('routes all directed pairs in a 3×3 grid without entering a card',()=>{const links=cards.flatMap((_,a)=>cards.flatMap((_,b)=>a===b?[]:[link(a,b)]));for(const route of routeOverviewGroups(cards,links))for(let i=1;i<route.points.length;i++)for(const card of cards)expect(crossesCard(route.points[i-1],route.points[i],card),route.fromGroupKey+'→'+route.toGroupKey+' through '+card.key).toBe(false);});
 it('gives distinct ports to two arrivals from above and an outgoing reverse link',()=>{const routes=routeOverviewGroups(cards,[link(0,4),link(1,4),link(4,1)]);expect(routes[0].points.at(-1)).not.toEqual(routes[1].points.at(-1));expect(routes[1].points.at(-1)).not.toEqual(routes[2].points[0]);});
 it('keeps nonneighbor same-row links outside intervening cards',()=>{const [route]=routeOverviewGroups(cards,[link(0,2)]);expect(route.points).toHaveLength(6);for(let i=1;i<route.points.length;i++)expect(crossesCard(route.points[i-1],route.points[i],cards[1])).toBe(false);});
 it('reserves a footer band below last-row detours and count labels',()=>{const six=cards.slice(0,6),routes=routeOverviewGroups(six,[link(3,5)]),height=overviewBoardHeight(six,routes);expect(height).toBe(652);for(const route of routes){expect(Math.max(...route.points.map(point=>point.y))).toBeLessThanOrEqual(height-60);expect(route.y-12).toBeLessThan(height-40);}expect(overviewBoardHeight(six,routeOverviewGroups(six,[link(3,4)]))).toBe(600);});
 it('separates shared row-gap lanes and count labels independent of input order',()=>{
  const links=[link(0,3),link(1,4),link(2,5),link(4,0),link(0,2),link(2,0)];
  const routes=routeOverviewGroups(cards,links);
  expect(new Set(routes.map(route=>route.y)).size).toBe(routes.length);
  expect(new Set(routes.map(route=>`${route.x},${route.y}`)).size).toBe(routes.length);
  expect(routeOverviewGroups(cards,[...links].reverse())).toEqual(routes);
  for(const route of routes)for(let i=1;i<route.points.length;i++)for(const card of cards)expect(crossesCard(route.points[i-1],route.points[i],card)).toBe(false);
 });
 it('gives same-column detours independent vertical tracks',()=>{
  const routes=routeOverviewGroups(cards,[link(0,2),link(0,8),link(6,2)]);
  const tracks=routes.map(route=>route.points[1].x);
  expect(tracks[0]).not.toBe(tracks[1]);
  for(const route of routes)expect(route.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y))).toBe(true);
 });
 it('keeps exterior leftmost detours and labels within the SVG board',()=>{
  const links=cards.flatMap((_,a)=>cards.flatMap((_,b)=>a===b?[]:[link(a,b)]));
  for(const route of routeOverviewGroups(cards,links)){
   for(const point of route.points){expect(point.x,route.fromGroupKey+'→'+route.toGroupKey).toBeGreaterThanOrEqual(8);expect(point.x).toBeLessThan(1300);expect(point.y).toBeGreaterThanOrEqual(0);}
   expect(route.x-10).toBeGreaterThanOrEqual(0);expect(route.x+10).toBeLessThan(1300);
  }
  const [reverse]=routeOverviewGroups(cards,[link(2,0)]);expect(reverse.points[3].x).toBeGreaterThanOrEqual(8);
 });
 it('rejects a link to an absent group rather than drawing a phantom target',()=>expect(()=>routeOverviewGroups(cards,[link(0,99)])).toThrow('missing-group'));
 it('keeps aggregate semantics and exact counts',()=>{const result=routeOverviewGroups(cards,[{...link(0,1),uniqueEdgeCount:19},link(1,0)]);expect(result.map(r=>r.semantics)).toEqual(['aggregate-only','aggregate-only']);expect(result[0].uniqueEdgeCount).toBe(19);expect(result.map(r=>r.reverse)).toEqual([false,true]);});
});
