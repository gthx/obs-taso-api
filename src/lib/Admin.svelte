<script>
  import { onMount } from 'svelte';
  import { obsWebSocket, connectionStatus, matchData } from './obsWebSocket.js';
  
  let wsUrl = 'ws://localhost:4455';
  let wsPassword = '';
  let isConnecting = false;
  
  // Local copy of match data for form binding
  let homeTeamName = '';
  let homeTeamScore = 0;
  let awayTeamName = '';
  let awayTeamScore = 0;
  let period = 1;
  let time = '20:00';
  
  // Subscribe to match data changes
  $: if ($matchData) {
    homeTeamName = $matchData.homeTeam?.name || '';
    homeTeamScore = $matchData.homeTeam?.score || 0;
    awayTeamName = $matchData.awayTeam?.name || '';
    awayTeamScore = $matchData.awayTeam?.score || 0;
    period = $matchData.period || 1;
    time = $matchData.time || '20:00';
  }
  
  async function connect() {
    isConnecting = true;
    try {
      await obsWebSocket.connect(wsUrl, wsPassword);
      // Try to load existing match data
      await obsWebSocket.getMatchData();
    } catch (error) {
      console.error('Connection failed:', error);
      alert(error.message || 'Failed to connect to OBS WebSocket. Make sure OBS is running and WebSocket is enabled.');
    } finally {
      isConnecting = false;
    }
  }
  
  function copyOverlayUrl() {
    const baseUrl = `${window.location.protocol}//${window.location.host}/overlay.html`;
    const url = wsPassword ? `${baseUrl}?password=${encodeURIComponent(wsPassword)}` : baseUrl;
    
    navigator.clipboard.writeText(url).then(() => {
      alert('Overlay URL copied to clipboard!');
    }).catch(() => {
      // Fallback: show the URL in a prompt
      prompt('Copy this URL for the overlay:', url);
    });
  }
  
  async function updateMatchData() {
    const data = {
      homeTeam: { name: homeTeamName, score: homeTeamScore },
      awayTeam: { name: awayTeamName, score: awayTeamScore },
      period,
      time,
      lastUpdated: new Date().toISOString()
    };
    
    await obsWebSocket.setMatchData(data);
  }
  
  function incrementScore(team) {
    if (team === 'home') {
      homeTeamScore++;
    } else {
      awayTeamScore++;
    }
    updateMatchData();
  }
  
  function decrementScore(team) {
    if (team === 'home' && homeTeamScore > 0) {
      homeTeamScore--;
    } else if (team === 'away' && awayTeamScore > 0) {
      awayTeamScore--;
    }
    updateMatchData();
  }
  
  onMount(() => {
    return () => {
      obsWebSocket.disconnect();
    };
  });
</script>

<div class="admin-container">
  <h1>Floorball Match Admin</h1>
  
  <div class="connection-panel">
    <h2>OBS WebSocket Connection</h2>
    <div class="connection-status">
      Status: <span class="status-{$connectionStatus}">{$connectionStatus}</span>
    </div>
    
    {#if $connectionStatus === 'disconnected' || $connectionStatus === 'error'}
      <div class="connection-form">
        <input
          type="text"
          placeholder="WebSocket URL"
          bind:value={wsUrl}
          disabled={isConnecting}
        />
        <input
          type="password"
          placeholder="Password (leave empty if no auth)"
          bind:value={wsPassword}
          disabled={isConnecting}
        />
        <button onclick={connect} disabled={isConnecting}>
          {isConnecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
      <div class="connection-note">
        <small>Leave password empty if authentication is disabled in OBS WebSocket settings</small>
      </div>
    {/if}
  </div>
  
  {#if $connectionStatus === 'connected'}
    <div class="connection-panel">
      <h3>OBS Setup</h3>
      <button class="copy-url-button" onclick={copyOverlayUrl}>
        📋 Copy Overlay URL
      </button>
      <div class="connection-note">
        <small>Use this URL in OBS → Add Source → Browser Source</small>
      </div>
    </div>
    
    <div class="match-controls">
      <h2>Match Information</h2>
      
      <div class="teams-section">
        <div class="team home">
          <h3>Home Team</h3>
          <input
            type="text"
            placeholder="Team name"
            bind:value={homeTeamName}
            onchange={updateMatchData}
          />
          <div class="score-control">
            <button onclick={() => decrementScore('home')}>-</button>
            <span class="score">{homeTeamScore}</span>
            <button onclick={() => incrementScore('home')}>+</button>
          </div>
        </div>
        
        <div class="team away">
          <h3>Away Team</h3>
          <input
            type="text"
            placeholder="Team name"
            bind:value={awayTeamName}
            onchange={updateMatchData}
          />
          <div class="score-control">
            <button onclick={() => decrementScore('away')}>-</button>
            <span class="score">{awayTeamScore}</span>
            <button onclick={() => incrementScore('away')}>+</button>
          </div>
        </div>
      </div>
      
      <div class="game-info">
        <div class="period-control">
          <label>Period:</label>
          <select bind:value={period} onchange={updateMatchData}>
            <option value={1}>1st</option>
            <option value={2}>2nd</option>
            <option value={3}>3rd</option>
          </select>
        </div>
        
        <div class="time-control">
          <label>Time:</label>
          <input
            type="text"
            bind:value={time}
            onchange={updateMatchData}
            pattern="[0-9]{1,2}:[0-9]{2}"
            placeholder="MM:SS"
          />
        </div>
      </div>
      
      <button class="update-button" onclick={updateMatchData}>
        Update Overlay
      </button>
    </div>
    
    <div class="preview">
      <h3>Current State Preview</h3>
      <div class="preview-content">
        <div>{homeTeamName} {homeTeamScore} - {awayTeamScore} {awayTeamName}</div>
        <div>Period {period} | {time}</div>
      </div>
    </div>
  {/if}
</div>

<style>
  :global(body) {
    background: #121212;
    color: #ffffff;
    margin: 0;
  }
  
  .admin-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
    font-family: Arial, sans-serif;
    min-height: 100vh;
  }
  
  h1 {
    text-align: center;
    color: #ffffff;
  }
  
  .connection-panel {
    background: #1e1e1e;
    padding: 20px;
    border-radius: 8px;
    margin-bottom: 20px;
    border: 1px solid #333;
  }
  
  .connection-status {
    margin-bottom: 15px;
    font-weight: bold;
    color: #ffffff;
  }
  
  .status-connected { color: #66bb6a; }
  .status-disconnected { color: #ef5350; }
  .status-error { color: #ffa726; }
  
  .connection-form {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  
  .connection-form input {
    flex: 1;
    min-width: 200px;
    padding: 8px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #2a2a2a;
    color: #ffffff;
  }
  
  .connection-form input:focus {
    outline: none;
    border-color: #2196F3;
  }
  
  .connection-note {
    margin-top: 10px;
    color: #aaa;
    font-style: italic;
  }
  
  button {
    padding: 8px 16px;
    background: #2196F3;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.2s;
  }
  
  button:hover {
    background: #42a5f5;
  }
  
  button:disabled {
    background: #555;
    cursor: not-allowed;
    opacity: 0.6;
  }
  
  .match-controls {
    background: #1e1e1e;
    padding: 20px;
    border-radius: 8px;
    border: 1px solid #333;
    box-shadow: 0 4px 8px rgba(0,0,0,0.3);
  }
  
  .match-controls h2 {
    color: #ffffff;
  }
  
  .teams-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 30px;
    margin-bottom: 20px;
  }
  
  .team {
    text-align: center;
  }
  
  .team input {
    width: 100%;
    padding: 8px;
    margin-bottom: 10px;
    border: 1px solid #444;
    border-radius: 4px;
    font-size: 16px;
    background: #2a2a2a;
    color: #ffffff;
  }
  
  .team input:focus {
    outline: none;
    border-color: #2196F3;
  }
  
  .team h3 {
    color: #ffffff;
  }
  
  .score-control {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 15px;
    margin-top: 10px;
  }
  
  .score {
    font-size: 48px;
    font-weight: bold;
    min-width: 80px;
    text-align: center;
    color: #ffffff;
  }
  
  .score-control button {
    width: 40px;
    height: 40px;
    font-size: 20px;
    padding: 0;
  }
  
  .game-info {
    display: flex;
    gap: 20px;
    justify-content: center;
    margin: 20px 0;
  }
  
  .period-control, .time-control {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  
  select, .time-control input {
    padding: 6px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #2a2a2a;
    color: #ffffff;
  }
  
  select:focus, .time-control input:focus {
    outline: none;
    border-color: #2196F3;
  }
  
  label {
    color: #ffffff;
  }
  
  .copy-url-button {
    display: block;
    margin: 10px auto;
    padding: 12px 24px;
    font-size: 16px;
    background: #ff9800;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .copy-url-button:hover {
    background: #ffb74d;
  }
  
  .update-button {
    display: block;
    margin: 20px auto;
    padding: 12px 24px;
    font-size: 16px;
    background: #4CAF50;
  }
  
  .update-button:hover {
    background: #66bb6a;
  }
  
  .preview {
    margin-top: 20px;
    padding: 15px;
    background: #2a2a2a;
    border-radius: 8px;
    text-align: center;
    border: 1px solid #444;
  }
  
  .preview h3 {
    color: #ffffff;
    margin-bottom: 10px;
  }
  
  .preview-content {
    font-size: 18px;
    margin-top: 10px;
    color: #ffffff;
  }
</style>