<script>
  import { onMount } from 'svelte';
  import { obsWebSocket, connectionStatus, matchData } from './obsWebSocket.js';
  
  let isConnected = false;
  let retryCount = 0;
  const maxRetries = 10;
  
  // Get password from URL query parameter
  function getPasswordFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('password') || '';
  }
  
  const password = getPasswordFromUrl();
  
  async function connectToOBS() {
    retryCount++;
    try {
      await obsWebSocket.connect('ws://localhost:4455', password);
      isConnected = true;
      retryCount = 0; // Reset on successful connection
      
      // Load initial match data
      await obsWebSocket.getMatchData();
      
      // Listen for match updates
      obsWebSocket.addEventListener('CustomEvent', (event) => {
        if (event.eventData && event.eventData.eventName === 'MatchUpdate') {
          console.log('Received match update:', event.eventData.eventData);
        }
      });
    } catch (error) {
      console.error('Failed to connect:', error);
      
      if (retryCount < maxRetries) {
        // Retry connection after a delay
        setTimeout(connectToOBS, 2000);
      }
    }
  }
  
  onMount(() => {
    connectToOBS();
    
    return () => {
      obsWebSocket.disconnect();
    };
  });
</script>

<div class="overlay-container">
  {#if $connectionStatus === 'connected' && $matchData}
    <div class="scoreboard">
      <div class="team home">
        <div class="team-name">{$matchData.homeTeam?.name || 'Home'}</div>
        <div class="score">{$matchData.homeTeam?.score || 0}</div>
      </div>
      
      <div class="match-info">
        <div class="period">Period {$matchData.period || 1}</div>
        <div class="time">{$matchData.time || '20:00'}</div>
      </div>
      
      <div class="team away">
        <div class="team-name">{$matchData.awayTeam?.name || 'Away'}</div>
        <div class="score">{$matchData.awayTeam?.score || 0}</div>
      </div>
    </div>
  {:else if $connectionStatus === 'disconnected' && retryCount < maxRetries}
    <div class="connecting">
      Connecting to OBS... (Attempt {retryCount}/{maxRetries})
    </div>
  {/if}
</div>

<style>
  .overlay-container {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    font-family: 'Arial Black', Arial, sans-serif;
    color: white;
    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
    user-select: none;
  }
  
  .scoreboard {
    display: flex;
    align-items: center;
    gap: 30px;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.6));
    padding: 20px 40px;
    border-radius: 10px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  }
  
  .team {
    text-align: center;
    min-width: 150px;
  }
  
  .team-name {
    font-size: 24px;
    margin-bottom: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  
  .score {
    font-size: 64px;
    font-weight: bold;
    line-height: 1;
    color: #fff;
    text-shadow: 
      3px 3px 6px rgba(0, 0, 0, 0.9),
      0 0 20px rgba(255, 255, 255, 0.3);
  }
  
  .match-info {
    text-align: center;
    padding: 0 20px;
    border-left: 2px solid rgba(255, 255, 255, 0.3);
    border-right: 2px solid rgba(255, 255, 255, 0.3);
  }
  
  .period {
    font-size: 20px;
    margin-bottom: 8px;
    color: #ffd700;
    text-transform: uppercase;
  }
  
  .time {
    font-size: 32px;
    font-weight: bold;
    font-variant-numeric: tabular-nums;
  }
  
  .connecting {
    background: rgba(0, 0, 0, 0.7);
    padding: 10px 20px;
    border-radius: 5px;
    font-size: 14px;
    color: #ccc;
  }
  
  /* Animation for score changes */
  .score {
    transition: transform 0.3s ease, color 0.3s ease;
  }
  
  .score:active {
    transform: scale(1.2);
    color: #ffd700;
  }
  
  /* Responsive adjustments */
  @media (max-width: 768px) {
    .scoreboard {
      gap: 20px;
      padding: 15px 25px;
    }
    
    .team-name {
      font-size: 18px;
    }
    
    .score {
      font-size: 48px;
    }
    
    .period {
      font-size: 16px;
    }
    
    .time {
      font-size: 24px;
    }
  }
</style>