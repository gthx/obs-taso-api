<script>
    import { onMount } from "svelte";
    import { torneopalApi } from "./lib/torneopalApi.js";

    // Settings state
    let obsWsUrl = $state("ws://localhost:4455");
    let obsWsPassword = $state("");
    let apiKey = $state("");
    let settingsOpen = $state(false);

    // Load match state
    let remoteMatchId = $state("");
    let isLoadingRemote = $state(false);
    let loadError = $state("");

    // Match list state
    let matches = $state([]);

    function saveObsUrl(e) {
        obsWsUrl = e.target.value;
        localStorage.setItem("obs-ws-url", obsWsUrl);
    }

    function saveObsPassword(e) {
        obsWsPassword = e.target.value;
        localStorage.setItem("obs-ws-password", obsWsPassword);
    }

    function saveApiKey(e) {
        apiKey = e.target.value;
        torneopalApi.setApiKey(apiKey);
    }

    // Store match data in localStorage by match ID
    function storeMatchData(matchId, matchData) {
        const key = `match-data-${matchId}`;
        localStorage.setItem(key, JSON.stringify(matchData));
    }

    // Load remote match
    async function loadRemoteMatch() {
        if (!remoteMatchId || !apiKey) return;

        isLoadingRemote = true;
        loadError = "";

        try {
            const result = await torneopalApi.getMatchEnhanced(remoteMatchId);

            if (result && result.match) {
                const match = result.match;
                let periodLengths = [0, 1200, 1200, 1200, 300, 0, 0];
                if (match.period_sec) {
                    periodLengths = match.period_sec;
                }

                const matchInfo = {
                    homeTeam: match.team_A_name || "Home Team",
                    awayTeam: match.team_B_name || "Away Team",
                    homeTeamLogo: match.club_A_crest || "",
                    awayTeamLogo: match.club_B_crest || "",
                    date: match.date,
                    time: match.time,
                    venue: match.venue_name || "Venue",
                    category: match.category_name || "",
                    periodLengths,
                };

                storeMatchData(remoteMatchId, matchInfo);
                remoteMatchId = "";
                loadMatchList();
            } else {
                loadError = "Match not found. Check the Match ID.";
            }
        } catch (error) {
            loadError = `Failed to load match: ${error.message}`;
        } finally {
            isLoadingRemote = false;
        }
    }

    // Load match list from localStorage
    function loadMatchList() {
        const list = [];

        // Collect match-data-* keys
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("match-data-")) {
                const id = key.replace("match-data-", "");
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    if (data) {
                        list.push({
                            matchId: id,
                            homeTeam: data.homeTeam || "?",
                            awayTeam: data.awayTeam || "?",
                            date: data.date || "",
                            category: data.category || "",
                        });
                    }
                } catch (e) {
                    // skip invalid entries
                }
            }
        }

        // Also check local matches
        const localMatches = torneopalApi.getStoredLocalMatches();
        for (const [id, match] of Object.entries(localMatches)) {
            // Only add if not already in list from match-data-*
            if (!list.some((m) => m.matchId === id)) {
                list.push({
                    matchId: id,
                    homeTeam: match.team_A_name || "?",
                    awayTeam: match.team_B_name || "?",
                    date: match.date || "",
                    category: match.category_name || "",
                });
            }
        }

        // Sort by date descending
        list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

        matches = list;
    }

    function deleteMatch(matchId) {
        // Remove match-data cache
        localStorage.removeItem(`match-data-${matchId}`);

        // Remove from local matches if applicable
        if (torneopalApi.isLocalMatch(matchId)) {
            torneopalApi.deleteLocalMatch(matchId);
        }

        loadMatchList();
    }

    function handleClickOutsideSettings(e) {
        if (settingsOpen && !e.target.closest(".settings-menu")) {
            settingsOpen = false;
        }
    }

    onMount(() => {
        // Load saved settings
        const savedUrl = localStorage.getItem("obs-ws-url");
        const savedPassword = localStorage.getItem("obs-ws-password");
        const savedApiKey = torneopalApi.getStoredApiKey();

        if (savedUrl) obsWsUrl = savedUrl;
        if (savedPassword) obsWsPassword = savedPassword;
        if (savedApiKey) apiKey = savedApiKey;

        // Load match list
        loadMatchList();

        document.addEventListener("click", handleClickOutsideSettings);
        return () => document.removeEventListener("click", handleClickOutsideSettings);
    });
</script>

<div class="home-container">
    <header class="top-bar">
        <h1>SalibandyOBS</h1>
        <div class="settings-menu">
            <button
                class="hamburger-btn"
                onclick={(e) => {
                    e.stopPropagation();
                    settingsOpen = !settingsOpen;
                }}
                title="Settings"
            >
                <span class="hamburger-icon"></span>
                <span class="hamburger-icon"></span>
                <span class="hamburger-icon"></span>
            </button>
            {#if settingsOpen}
                <div class="settings-popup" onclick={(e) => e.stopPropagation()}>
                    <h3>Settings</h3>
                    <div class="setting-field">
                        <label for="obs-url">OBS WebSocket URL</label>
                        <input
                            id="obs-url"
                            type="text"
                            value={obsWsUrl}
                            onchange={saveObsUrl}
                            placeholder="ws://localhost:4455"
                        />
                    </div>
                    <div class="setting-field">
                        <label for="obs-password">OBS WebSocket Password</label>
                        <input
                            id="obs-password"
                            type="password"
                            value={obsWsPassword}
                            onchange={saveObsPassword}
                            placeholder="(optional)"
                        />
                    </div>
                    <div class="setting-field">
                        <label for="api-key">Torneopal API Key</label>
                        <input
                            id="api-key"
                            type="password"
                            value={apiKey}
                            onchange={saveApiKey}
                            placeholder="Enter API Key"
                        />
                    </div>
                </div>
            {/if}
        </div>
    </header>

    <section class="match-list-section">
        <div class="load-row">
            <input
                type="text"
                class="match-id-input"
                placeholder="Match ID"
                bind:value={remoteMatchId}
                onkeydown={(e) => {
                    if (e.key === "Enter") loadRemoteMatch();
                }}
            />
            <button
                class="load-btn"
                onclick={loadRemoteMatch}
                disabled={!remoteMatchId || !apiKey || isLoadingRemote}
            >
                {isLoadingRemote ? "Loading..." : "Load"}
            </button>
        </div>

        {#if loadError}
            <div class="error-message">{loadError}</div>
        {/if}

        {#if matches.length === 0}
            <p class="empty-state">No matches loaded yet.</p>
        {:else}
            <table class="match-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Match</th>
                        <th>Date</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {#each matches as match (match.matchId)}
                        <tr class="match-row">
                            <td class="id-cell"><a href="match.html?matchId={encodeURIComponent(match.matchId)}" class="match-link">{match.matchId}</a></td>
                            <td class="teams-cell"><a href="match.html?matchId={encodeURIComponent(match.matchId)}" class="match-link">{match.homeTeam} vs {match.awayTeam}</a></td>
                            <td><a href="match.html?matchId={encodeURIComponent(match.matchId)}" class="match-link">{match.date}</a></td>
                            <td class="actions-cell">
                                <button
                                    class="delete-btn"
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        deleteMatch(match.matchId);
                                    }}
                                    title="Remove from list"
                                >
                                    ✕
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    </section>
</div>

<style>
    :global(body) {
        background: #121212;
        color: #ffffff;
        margin: 0;
    }

    .home-container {
        padding: 10px;
        font-family: Arial, sans-serif;
    }

    /* Top bar */
    .top-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
    }

    h1 {
        color: #fff;
        font-size: 16px;
        margin: 0;
    }

    /* Hamburger menu */
    .settings-menu {
        position: relative;
    }

    .hamburger-btn {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        background: transparent;
        border: 1px solid #444;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.2s;
    }

    .hamburger-btn:hover {
        background: #252525;
    }

    .hamburger-icon {
        display: block;
        width: 18px;
        height: 2px;
        background: #ccc;
        border-radius: 1px;
    }

    .settings-popup {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        width: 260px;
        background: #1e1e1e;
        border: 1px solid #444;
        border-radius: 6px;
        padding: 12px;
        z-index: 100;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }

    .settings-popup h3 {
        color: #aaa;
        font-size: 11px;
        margin: 0 0 10px 0;
        font-weight: normal;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .setting-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 8px;
    }

    .setting-field:last-child {
        margin-bottom: 0;
    }

    .setting-field label {
        font-size: 11px;
        color: #888;
    }

    .setting-field input {
        padding: 5px 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 13px;
    }

    .setting-field input:focus {
        outline: none;
        border-color: #2196f3;
    }

    /* Match list */
    .match-list-section {
        background: #1e1e1e;
        border: 1px solid #333;
        border-radius: 6px;
        padding: 10px;
    }

    .load-row {
        display: flex;
        gap: 6px;
        margin-bottom: 10px;
    }

    .match-id-input {
        flex: 1;
        min-width: 0;
        padding: 5px 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #fff;
        font-size: 13px;
    }

    .match-id-input:focus {
        outline: none;
        border-color: #2196f3;
    }

    .load-btn {
        padding: 5px 14px;
        background: #ff5722;
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-weight: bold;
        cursor: pointer;
        white-space: nowrap;
    }

    .load-btn:hover:not(:disabled) {
        background: #ff7043;
    }

    .load-btn:disabled {
        background: #555;
        cursor: not-allowed;
        opacity: 0.6;
    }

    .error-message {
        background: rgba(244, 67, 54, 0.15);
        border: 1px solid #f44336;
        border-radius: 4px;
        padding: 6px 10px;
        margin-bottom: 10px;
        color: #ef9a9a;
        font-size: 13px;
    }

    .empty-state {
        color: #666;
        font-size: 13px;
        text-align: center;
        padding: 12px;
    }

    .match-table {
        width: 100%;
        border-collapse: collapse;
    }

    .match-table th {
        text-align: left;
        padding: 4px 8px;
        border-bottom: 1px solid #333;
        color: #888;
        font-size: 11px;
        font-weight: normal;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .match-row:hover {
        background: #252525;
    }

    .match-link {
        color: inherit;
        text-decoration: none;
        display: block;
    }

    .match-link:hover {
        text-decoration: underline;
    }

    .match-row td {
        padding: 6px 8px;
        border-bottom: 1px solid #2a2a2a;
        font-size: 13px;
        white-space: nowrap;
    }

    .teams-cell {
        font-weight: bold;
        color: #fff;
    }

    .id-cell {
        color: #888;
        font-family: monospace;
        font-size: 11px;
    }

    .actions-cell {
        width: 30px;
        text-align: center;
    }

    .delete-btn {
        background: transparent;
        border: 1px solid transparent;
        color: #666;
        font-size: 13px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
    }

    .delete-btn:hover {
        color: #f44336;
        border-color: #f44336;
        background: rgba(244, 67, 54, 0.1);
    }

    label {
        color: #ffffff;
    }
</style>