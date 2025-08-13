/**
 * Torneopal API Integration Module
 * Handles API requests to Torneopal for floorball match data
 */

class TorneopalAPI {
  constructor() {
    this.baseUrl = "https://salibandy.api.torneopal.com/taso/rest/";
    this.apiKey = this.getStoredApiKey();
  }

  /**
   * Get stored API key from localStorage
   */
  getStoredApiKey() {
    return localStorage.getItem("torneopal-api-key") || "";
  }

  /**
   * Set and store API key
   */
  setApiKey(key) {
    this.apiKey = key;
    localStorage.setItem("torneopal-api-key", key);
  }

  /**
   * Make API request with proper error handling
   */
  async makeRequest(endpoint, params = {}) {
    if (!this.apiKey) {
      throw new Error("API key is required");
    }

    const url = new URL(endpoint, this.baseUrl);

    // Add API key and other parameters
    url.searchParams.set("api_key", this.apiKey);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, value);
      }
    });

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`API error: ${data.error}`);
      }

      return data;
    } catch (error) {
      console.error("Torneopal API request failed:", error);
      throw error;
    }
  }

  /**
   * Get list of districts
   */
  async getDistricts() {
    return await this.makeRequest("getDistricts");
  }

  /**
   * Get clubs by district
   */
  async getClubs(district) {
    return await this.makeRequest("getClubs", { district });
  }

  /**
   * Get venues by district and club
   */
  async getVenues(district, clubId) {
    return await this.makeRequest("getVenues", {
      district,
      club_id: clubId,
    });
  }

  /**
   * Search for matches with various filters
   */
  async getMatches(filters = {}) {
    const params = {};
    params.competition_id = "sb2025";
    params.category_id = 444;

    if (filters.venueId) params.venue_id = filters.venueId;
    if (filters.teamId) params.team_id = filters.teamId;
    if (filters.clubId) params.club_id = filters.clubId;
    if (filters.category) params.category = filters.category;
    if (filters.dateFrom) params.date_from = filters.dateFrom;
    if (filters.dateTo) params.date_to = filters.dateTo;
    if (filters.limit) params.per_page = Math.min(filters.limit, 100);
    if (filters.page) params.page = filters.page;
    if (filters.officialOnly) params.official_only = 1;

    return await this.makeRequest("getMatches", params);
  }

  /**
   * Get specific match details by ID
   */
  async getMatch(matchId) {
    return await this.makeRequest("getMatch", { match_id: matchId });
  }

  /**
   * Get current live score for a specific match
   * This endpoint is designed for frequent polling (max 1 per second)
   */
  async getScore(matchId) {
    return await this.makeRequest("getScore", { match_id: matchId });
  }

  /**
   * Get teams information
   */
  async getTeams(filters = {}) {
    const params = {};

    if (filters.clubId) params.club_id = filters.clubId;
    if (filters.district) params.district = filters.district;
    if (filters.category) params.category = filters.category;

    return await this.makeRequest("getTeams", params);
  }

  /**
   * Get specific team by team ID
   */
  async getTeam(teamId) {
    return await this.makeRequest("getTeam", { team_id: teamId });
  }

  /**
   * Get club information by club ID
   */
  async getClub(clubId) {
    return await this.makeRequest("getClub", { club_id: clubId });
  }

  /**
   * Test API connection
   */
  async testConnection() {
    try {
      await this.getDistricts();
      return { success: true, message: "API connection successful" };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Store selected match data in localStorage
   */
  storeSelectedMatch(matchId, matchData) {
    localStorage.setItem("selected-match-id", matchId);
    localStorage.setItem("selected-match-data", JSON.stringify(matchData));
  }

  /**
   * Get stored selected match data
   */
  getStoredSelectedMatch() {
    const matchId = localStorage.getItem("selected-match-id");
    const matchDataStr = localStorage.getItem("selected-match-data");

    if (matchId && matchDataStr) {
      try {
        const matchData = JSON.parse(matchDataStr);
        return { matchId, matchData };
      } catch (error) {
        console.error("Failed to parse stored match data:", error);
        return null;
      }
    }

    return null;
  }

  /**
   * Clear stored match data
   */
  clearStoredMatch() {
    localStorage.removeItem("selected-match-id");
    localStorage.removeItem("selected-match-data");
  }

  /**
   * Get static local match ID
   */
  getLocalMatchId() {
    return "local-match";
  }

  /**
   * Create and store a local match
   */
  async createLocalMatch(matchData) {
    const {
      date,
      time,
      homeTeamId,
      homeTeamData,
      awayTeamName,
      awayTeamLogo,
      venue = "Local Venue",
      category = "Local Match"
    } = matchData;

    const localMatchId = this.getLocalMatchId();
    
    const localMatch = {
      match_id: localMatchId,
      date,
      time,
      team_A_name: homeTeamData.team_name || "Home Team",
      team_B_name: awayTeamName,
      club_A_crest: homeTeamData.club_crest || "",
      club_B_crest: awayTeamLogo || "",
      venue_name: venue,
      category_name: category,
      is_local: true,
      created_at: new Date().toISOString(),
      home_team_id: homeTeamId,
      home_team_data: homeTeamData
    };

    // Store local match data
    const localMatches = this.getStoredLocalMatches();
    localMatches[localMatchId] = localMatch;
    localStorage.setItem("local-matches", JSON.stringify(localMatches));

    return localMatch;
  }

  /**
   * Get all stored local matches
   */
  getStoredLocalMatches() {
    const stored = localStorage.getItem("local-matches");
    return stored ? JSON.parse(stored) : {};
  }

  /**
   * Get specific local match by ID
   */
  getLocalMatch(matchId) {
    const localMatches = this.getStoredLocalMatches();
    return localMatches[matchId] || null;
  }

  /**
   * Check if match ID is a local match
   */
  isLocalMatch(matchId) {
    return matchId === "local-match";
  }

  /**
   * Enhanced getMatch that supports both local and remote matches
   */
  async getMatchEnhanced(matchId) {
    if (this.isLocalMatch(matchId)) {
      const localMatch = this.getLocalMatch(matchId);
      if (localMatch) {
        return { match: localMatch };
      }
      throw new Error("Local match not found");
    } else {
      return await this.getMatch(matchId);
    }
  }

  /**
   * Delete a local match
   */
  deleteLocalMatch(matchId) {
    const localMatches = this.getStoredLocalMatches();
    if (localMatches[matchId]) {
      delete localMatches[matchId];
      localStorage.setItem("local-matches", JSON.stringify(localMatches));
      return true;
    }
    return false;
  }
}

// Create singleton instance
export const torneopalApi = new TorneopalAPI();
