import { useState, useEffect } from 'react';
import LearningPage from './components/LearningPage';
import WordListPage from './components/WordListPage';
import SettingsPage from './components/SettingsPage';
import { migrateOldProgress, migrateProgressToTargetOnly } from './utils/storage';
import { UI_TEXT } from './utils/langHelpers';

const TAB_ACTIVE_COLORS = { learn: '#ffd3be', wordlist: '#a7e4fe', settings: '#e0feb1' };

function TabIcon({ type, active }) {
  const color = active ? (TAB_ACTIVE_COLORS[type] || '#f7d376') : '#ffffff';
  if (type === 'learn') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    );
  }
  if (type === 'wordlist') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="8" y1="7" x2="16" y2="7" />
        <line x1="8" y1="11" x2="16" y2="11" />
        <line x1="8" y1="15" x2="12" y2="15" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// Run migrations once on module load
migrateOldProgress();
migrateProgressToTargetOnly();

export default function App() {
  const [page, setPage] = useState('learn');
  const [reviewMode, setReviewMode] = useState(false);
  const [wordListFilter, setWordListFilter] = useState(null);
  const [wordListRefreshKey, setWordListRefreshKey] = useState(0);
  const [nativeLang, setNativeLang] = useState(() => localStorage.getItem('app_native') || 'en');
  const [targetLang, setTargetLang] = useState(() => localStorage.getItem('app_target') || 'ja');
  const [navH, setNavH] = useState(57);

  // Set --app-h CSS variable to window.innerHeight (fixes mobile Safari 100vh bug)
  useEffect(() => {
    const update = () => {
      setNavH(window.innerHeight < 833 ? 52 : 57);
      document.documentElement.style.setProperty('--app-h', `${window.innerHeight}px`);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Persist category/level filters across tab switches
  const [learningCategory, setLearningCategory] = useState('all');
  const [learningLevel, setLearningLevel] = useState('beginner');

  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;

  const handleTabClick = (tab) => {
    if (reviewMode) setReviewMode(false);
    setWordListFilter(null);
    setPage(tab);
    if (tab === 'wordlist') setWordListRefreshKey(k => k + 1);
  };

  const handleStartReview = () => {
    setReviewMode(true);
  };

  const handleExitReview = () => {
    setReviewMode(false);
    setPage('wordlist');
    setWordListRefreshKey(k => k + 1);
  };

  const handleGoToStarred = () => {
    setWordListFilter('starred');
    setPage('wordlist');
  };

  const handleLanguageChange = ({ native, target }) => {
    if (native !== undefined) {
      setNativeLang(native);
      localStorage.setItem('app_native', native);
    }
    if (target !== undefined) {
      setTargetLang(target);
      localStorage.setItem('app_target', target);
    }
  };

  // Which tab to highlight
  const activeTab = reviewMode ? 'wordlist' : page;

  return (
    <div className="h-screen w-screen bg-neutral-200 flex items-center justify-center font-cute overflow-hidden">
      <div
        className="w-[402px] h-[841px] flex flex-col overflow-hidden rounded-[2rem] shadow-2xl border border-neutral-300 relative bg-warm-bg"
        style={{ maxHeight: 'var(--app-h, 100vh)' }}
      >

        {/* Main content — all pages stay mounted to preserve state; display:none hides inactive ones */}
        <div className="flex-1 min-h-0 overflow-visible">
          <div style={{ display: (page === 'learn' || reviewMode) ? undefined : 'none', height: '100%' }}>
            <LearningPage
              isReview={reviewMode}
              onExitReview={handleExitReview}
              onGoToStarred={handleGoToStarred}
              nativeLang={nativeLang}
              targetLang={targetLang}
              selectedCategory={learningCategory}
              selectedLevel={learningLevel}
              onCategoryChange={setLearningCategory}
              onLevelChange={setLearningLevel}
              isVisible={page === 'learn' || reviewMode}
            />
          </div>
          <div style={{ display: (page === 'wordlist' && !reviewMode) ? undefined : 'none', height: '100%' }}>
            <WordListPage
              onStartReview={handleStartReview}
              initialFilter={wordListFilter}
              nativeLang={nativeLang}
              targetLang={targetLang}
              refreshKey={wordListRefreshKey}
            />
          </div>
          <div style={{ display: (page === 'settings' && !reviewMode) ? undefined : 'none', height: '100%' }}>
            <SettingsPage
              nativeLang={nativeLang}
              targetLang={targetLang}
              onLanguageChange={handleLanguageChange}
            />
          </div>
        </div>

        {/* Bottom tab bar */}
        <div className="shrink-0 relative overflow-visible" style={{ height: navH, backgroundColor: '#2b2a26' }}>
          {/* Nav separator line at top */}
          <img
            src="/assets/figma/nav-separator.png"
            alt=""
            className="absolute top-0 left-0 w-full pointer-events-none select-none"
            style={{ height: 3 }}
          />
          <div className="flex items-center justify-around h-full px-4 pt-1">
            {[
              { key: 'learn', label: t.learn },
              { key: 'wordlist', label: t.wordlist },
              { key: 'settings', label: t.settings },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => handleTabClick(tab.key)}
                className="flex flex-col items-center gap-0.5 min-w-[60px]"
              >
                <TabIcon type={tab.key} active={activeTab === tab.key} />
                <span
                  className="text-[10px] font-bold"
                  style={{ color: activeTab === tab.key ? TAB_ACTIVE_COLORS[tab.key] : '#ffffff' }}
                >
                  {tab.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
