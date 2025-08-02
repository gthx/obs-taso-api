import { mount } from 'svelte'
import './app.css'
import Admin from './lib/Admin.svelte'

const app = mount(Admin, {
  target: document.getElementById('app'),
})

export default app