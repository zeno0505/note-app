import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import {routes} from './routes';
import './style.css';
const router = createRouter({history:createWebHashHistory(),routes});
createApp(App).use(router).use(PrimeVue,{theme:{preset:Aura, options:{darkModeSelector:false}}}).mount('#app');
