import React from 'react';
import Cover from './Cover.jsx';
import { FolderIcon, TrashIcon, ImageIcon, StatusPill, ActionButton, formatPlaytime, LauncherLogo, FavButton } from './bits.jsx';
import { t, DEC } from '../i18n.js';

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1).replace('.', DEC)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function GameRow({ game, provider, launching, onPlay, onFolder, onRemove, onSetCover, onUpdate, running, onFocus, onUninstall, favorite, onToggleFavorite }) {
  const notInstalled = game.status === 'notInstalled';
  const disabled = game.status === 'missing';
  return (
    (<div
      className={`row ${launching ? 'launching' : ''} ${notInstalled ? 'not-installed' : ''}`}
      onDoubleClick={!disabled ? (running ? onFocus : onPlay) : undefined}
    >
      <div className="thumb"><Cover game={{ ...game, covers: [...(game.wides || []), ...(game.covers || [])] }} provider={provider} wide /></div>
      <div className="row-name" title={game.name}>
        <span>{game.name}</span>
      </div>
      <div className="row-source">
        <LauncherLogo provider={provider} small />
        {provider?.name}
      </div>
      <div className="row-size">{formatPlaytime(game.playtimeMin)}</div>
      <div className="row-size">{formatSize(game.sizeBytes)}</div>
      <div className="row-status"><StatusPill status={game.status} update={game.update} running={running} inline /></div>
      <div className="row-actions">
        {onToggleFavorite && <FavButton active={favorite} onToggle={onToggleFavorite} className="ghost in-row" />}
        <button className="ghost" onClick={onSetCover} title={t("Cover ändern")}><ImageIcon /></button>
        {!notInstalled && <button className="ghost" onClick={onFolder} title={t("Installationsordner öffnen")}><FolderIcon /></button>}
        {onUninstall && <button className="ghost" onClick={onUninstall} title={t("Deinstallieren")}><TrashIcon /></button>}
        {onRemove && <button className="ghost" onClick={onRemove} title={t("Aus Ludora entfernen")}><TrashIcon /></button>}
        <ActionButton game={game} launching={launching} onPlay={onPlay} onUpdate={onUpdate} running={running} onFocus={onFocus} small />
      </div>
    </div>)
  );
}

// Nur neu zeichnen, wenn sich etwas Sichtbares geändert hat (Handler rufen über eine Ref immer die aktuelle Funktion auf)
const same = (a, b) => a.game === b.game && a.provider === b.provider && a.launching === b.launching
  && a.running === b.running && a.favorite === b.favorite && !a.onUninstall === !b.onUninstall && !a.onRemove === !b.onRemove;
export default React.memo(GameRow, same);
