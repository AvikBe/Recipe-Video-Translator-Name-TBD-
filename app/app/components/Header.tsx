"use client";

interface HeaderProps {
  isDark: boolean;
  onToggleTheme?: () => void;
}

export default function Header({ isDark, onToggleTheme }: HeaderProps) {
  return (
    <header 
      className="w-full px-6 py-4"
      style={{
        backgroundColor: isDark ? 'var(--dark-bg)' : 'var(--light-bg)'
      }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Company Logo */}
        <div 
          className="text-base font-normal tracking-wide font-sans"
          style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}
        >
          COMPANY
        </div>
        
        {/* Navigation */}
        <nav className="flex items-center space-x-8">
          <a 
            href="#" 
            className="text-sm font-normal hover:opacity-70 transition-opacity font-sans"
            style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}
          >
            ABOUT
          </a>
          <a 
            href="#" 
            className="text-sm font-normal hover:opacity-70 transition-opacity font-sans"
            style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}
          >
            FAQ
          </a>
          <button 
            onClick={onToggleTheme}
            className="px-3 py-1.5 text-sm font-normal rounded-full transition-colors font-sans border"
            style={{
              backgroundColor: 'transparent',
              color: isDark ? 'var(--dark-text)' : 'var(--light-text)',
              borderColor: isDark ? 'var(--dark-border)' : 'var(--light-border)'
            }}
          >
            CONTACT US
          </button>
        </nav>
      </div>
    </header>
  );
}
