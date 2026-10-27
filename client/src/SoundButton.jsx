const speakerOn = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a9 9 0 0 1 0 11" /></svg>;
const speakerOff = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="m17 9 5 6m0-6-5 6" /></svg>;

export default function SoundButton({ soundOn, onClick, className = '' }) {
  return (
    <button className={`top-actions__button ${soundOn ? '' : 'top-actions__button--muted'} ${className}`.trim()} type="button" onClick={onClick} aria-label={soundOn ? 'Turn sound off' : 'Turn sound on'} aria-pressed={soundOn} title={soundOn ? 'Sound on' : 'Sound off'}>
      {soundOn ? speakerOn : speakerOff}
    </button>
  );
}
