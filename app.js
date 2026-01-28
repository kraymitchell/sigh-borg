/**
 * SIGH-BORG - Pun Delivery Engine
 * Fetches jokes from Google Sheets, tracks viewed jokes via localStorage,
 * and ensures full rotation before repeats.
 */
(function() {
  'use strict';

  // ========== CONFIGURATION ==========
  const CONFIG = Object.freeze({
    // Replace with your published Google Sheet CSV URL
    sheetUrl: 'https://docs.google.com/spreadsheets/d/1xHToJRMfDRV66SmOr_gXmPZCK9FM_-S-ZAbZrguP1b8/edit?usp=sharing',
    storageKey: 'sighborg_seen',
    cacheKey: 'sighborg_jokes',
    cacheTTL: 3600000, // 1 hour cache
    maxRetries: 3,
    retryDelay: 1000
  });

  // ========== DOM ELEMENTS ==========
  const $ = id => document.getElementById(id);
  const jokeContent = $('jokeContent');
  const nextBtn = $('nextBtn');
  const progress = $('progress');

  // ========== STORAGE UTILITIES ==========
  const Storage = {
    get(key) {
      try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : null;
      } catch {
        return null;
      }
    },

    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },

    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Silent fail
      }
    }
  };

  // ========== JOKE PARSER ==========
  const JokeParser = {
    format(text) {
      if (!text || typeof text !== 'string') {
        return { hasBreak: false, text: '' };
      }

      const normalized = text.trim().replace(/\.\.\.+/g, '…');

      // Priority 1: Ellipsis break
      if (normalized.includes('…')) {
        const parts = normalized.split('…');
        const setup = parts[0].trim() + '…';
        const punchline = parts.slice(1).join('…').trim();
        if (punchline) {
          return { hasBreak: true, setup, punchline };
        }
      }

      // Priority 2: Question break (exclude quoted questions and question-ellipsis)
      const questionMatch = normalized.match(/^(.+?\?)(\s+|$)(.*)$/);
      if (questionMatch && !normalized.includes('?"') && !normalized.includes('?…')) {
        const question = questionMatch[1].trim();
        const answer = questionMatch[3].trim();
        if (answer) {
          return { hasBreak: true, setup: question, punchline: answer };
        }
      }

      return { hasBreak: false, text: normalized };
    }
  };

  // ========== JOKE MANAGER ==========
  const JokeManager = {
    jokes: [],
    seenIds: new Set(),

    async init() {
      this.loadSeen();
      await this.loadJokes();
    },

    loadSeen() {
      const data = Storage.get(CONFIG.storageKey);
      if (Array.isArray(data)) {
        this.seenIds = new Set(data);
      }
    },

    saveSeen() {
      Storage.set(CONFIG.storageKey, [...this.seenIds]);
    },

    async loadJokes() {
      // Check cache first
      const cached = Storage.get(CONFIG.cacheKey);
      if (cached?.timestamp && Date.now() - cached.timestamp < CONFIG.cacheTTL) {
        this.jokes = cached.jokes || [];
        if (this.jokes.length > 0) {
          this.pruneSeenIds();
          return;
        }
      }

      await this.fetchJokes();
    },

    async fetchJokes(retries = CONFIG.maxRetries) {
      try {
        const response = await fetch(CONFIG.sheetUrl, {
          cache: 'no-store',
          headers: { 'Accept': 'text/csv' }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const csv = await response.text();
        this.parseCSV(csv);

        // Cache results
        Storage.set(CONFIG.cacheKey, {
          jokes: this.jokes,
          timestamp: Date.now()
        });

        // Prune seen IDs that no longer exist
        this.pruneSeenIds();

      } catch (err) {
        if (retries > 0) {
          await new Promise(r => setTimeout(r, CONFIG.retryDelay));
          return this.fetchJokes(retries - 1);
        }
        throw new Error('Failed to load jokes. Please refresh the page.');
      }
    },

    parseCSV(csv) {
      const lines = csv.split('\n');
      this.jokes = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Handle quoted values
        let text = line;
        if (text.startsWith('"') && text.endsWith('"')) {
          text = text.slice(1, -1).replace(/""/g, '"');
        }

        if (text) {
          this.jokes.push({
            id: this.hashString(text),
            text: text
          });
        }
      }
    },

    hashString(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
      }
      return hash.toString(36);
    },

    pruneSeenIds() {
      // Remove seen IDs for jokes that no longer exist (handles deleted jokes)
      const validIds = new Set(this.jokes.map(j => j.id));
      const prunedIds = [...this.seenIds].filter(id => validIds.has(id));
      
      if (prunedIds.length !== this.seenIds.size) {
        this.seenIds = new Set(prunedIds);
        this.saveSeen();
      }
    },

    getNext() {
      if (this.jokes.length === 0) return null;

      // Filter unseen jokes
      let unseen = this.jokes.filter(j => !this.seenIds.has(j.id));

      // Reset if all seen
      if (unseen.length === 0) {
        this.seenIds.clear();
        this.saveSeen();
        unseen = this.jokes;
      }

      // Random selection
      const idx = Math.floor(Math.random() * unseen.length);
      const joke = unseen[idx];

      // Mark as seen
      this.seenIds.add(joke.id);
      this.saveSeen();

      return {
        ...JokeParser.format(joke.text),
        progress: {
          seen: this.seenIds.size,
          total: this.jokes.length
        }
      };
    }
  };

  // ========== UI CONTROLLER ==========
  const UI = {
    showJoke(joke) {
      if (!joke) {
        this.showError('No jokes available');
        return;
      }

      let html;
      if (joke.hasBreak) {
        html = `
          <p class="joke-setup">${this.escapeHTML(joke.setup)}</p>
          <p class="joke-punchline">${this.escapeHTML(joke.punchline)}</p>
        `;
      } else {
        html = `<p class="joke-single">${this.escapeHTML(joke.text)}</p>`;
      }

      jokeContent.innerHTML = html;

      if (joke.progress) {
        progress.textContent = `${joke.progress.seen} of ${joke.progress.total} jokes seen`;
      }

      nextBtn.disabled = false;
    },

    showLoading() {
      jokeContent.innerHTML = '<p class="loading">Warming up the groan machine...</p>';
      nextBtn.disabled = true;
      progress.textContent = '';
    },

    showError(message) {
      jokeContent.innerHTML = `<p class="error">${this.escapeHTML(message)}</p>`;
      nextBtn.disabled = false;
    },

    escapeHTML(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  };

  // ========== MODAL CONTROLLER ==========
  const Modal = {
    init() {
      document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.addEventListener('click', e => {
          if (e.target === modal) this.close(modal);
        });

        modal.querySelector('.modal-close')?.addEventListener('click', () => {
          this.close(modal);
        });
      });

      $('privacyLink')?.addEventListener('click', e => {
        e.preventDefault();
        this.open($('privacyModal'));
      });

      $('termsLink')?.addEventListener('click', e => {
        e.preventDefault();
        this.open($('termsModal'));
      });

      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          document.querySelectorAll('.modal-overlay.active').forEach(m => this.close(m));
        }
      });
    },

    open(modal) {
      if (!modal) return;
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
      modal.querySelector('.modal-close')?.focus();
    },

    close(modal) {
      if (!modal) return;
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  };

  // ========== INITIALIZATION ==========
  async function init() {
    // Set copyright year
    $('year').textContent = new Date().getFullYear();

    // Initialize modals
    Modal.init();

    // Initialize jokes
    UI.showLoading();

    try {
      await JokeManager.init();
      const joke = JokeManager.getNext();
      UI.showJoke(joke);
    } catch (err) {
      UI.showError(err.message);
    }

    // Button handler
    nextBtn.addEventListener('click', () => {
      const joke = JokeManager.getNext();
      UI.showJoke(joke);
    });
  }

  // Run when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
