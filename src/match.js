import { mount } from 'svelte'
import './app.css'
import MatchView from './lib/MatchView.svelte'

const app = mount(MatchView, {
  target: document.getElementById('app'),
})

export default app