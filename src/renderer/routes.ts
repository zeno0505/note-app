import type {RouteRecordRaw} from 'vue-router';
import Overview from './views/Overview.vue';
import UsageStatistics from './views/UsageStatistics.vue';
import Settings from './views/Settings.vue';
import Detail from './views/Detail.vue';

export const routes:RouteRecordRaw[]=[
  {path:'/',component:Overview},
  {path:'/usage',component:UsageStatistics},
  {path:'/settings',component:Settings},
  {path:'/workstream/:id',component:Detail},
  {path:'/:pathMatch(.*)*',redirect:'/'},
];
