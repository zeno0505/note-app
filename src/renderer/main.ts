import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import Overview from './views/Overview.vue';
import Settings from './views/Settings.vue';
import Detail from './views/Detail.vue';
import './style.css';
const router = createRouter({history:createWebHashHistory(), routes:[
  {path:'/',component:Overview}, {path:'/settings',component:Settings},
  {path:'/workstream/:id',component:Detail}, {path:'/:pathMatch(.*)*',redirect:'/'},
]});
createApp(App).use(router).use(PrimeVue,{theme:{preset:Aura, options:{darkModeSelector:false}}}).mount('#app');
