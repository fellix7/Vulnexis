// Imported first by index.ts. `npm start` runs the compiled dist/index.js, which is production;
// `npm run dev` runs the .ts source through tsx, which is development. An explicit NODE_ENV always wins.
process.env.NODE_ENV ||= import.meta.filename.endsWith('.ts') ? 'development' : 'production';
export const isProduction = () => process.env.NODE_ENV === 'production';
