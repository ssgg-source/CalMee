'use client';

import React from 'react';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  return (
    <main className="ml-20 h-full min-w-0 flex-1 overflow-hidden bg-[#f8f7fb] [&>div]:!h-full">
      {children}
    </main>
  );
};

export default MainContent;
