import React from 'react';
import Cover from './Cover.jsx';
import { FolderIcon, TrashIcon, ImageIcon, StatusPill, ActionButton, formatPlaytime, LauncherLogo, FavButton, HereBadge, StarIcon } from './bits.jsx';
import { t } from '../i18n.js';

function GameCard({ game, provider, launching, onPlay, onFolder, onRemove, onSetCover, onUpdate, running, onFocus, onUninstall, favorite, onToggleFavorite, streamFrom, onStream, osName }) {
  const notInstalled = game.status === 'notInstalled';
  const disabled = game.status === 'missing';
  const playtime = formatPlaytime(game.playtimeMin);
  return (
    (<article
      className={`card ${running ? 'running' : ''} ${launching ? 'launching' : ''} ${notInstalled ? 'not-installed' : ''}`}
      onDoubleClick={!disabled ? (running ? onFocus : onPlay) : undefined}
    >
      <div className="cover">
        <Cover game={{ ...game, covers: [...(game.covers || []), ...(game.wides || [])] }} provider={provider} />
        <div className="overlay">
          <ActionButton game={game} launching={launching} onPlay={onPlay} onUpdate={onUpdate} running={running} onFocus={onFocus} streamFrom={streamFrom} onStream={onStream} />
          <div className="mini-actions">
            {!notInstalled && <button onClick={onFolder} title={t("Installationsordner öffnen")}><FolderIcon /></button>}
            {onToggleFavorite && <FavButton active={favorite} onToggle={onToggleFavorite} />}
            <button onClick={onSetCover} title={t("Cover ändern")}><ImageIcon /></button>
            {onUninstall && <button onClick={onUninstall} title={t("Deinstallieren")}><TrashIcon /></button>}
            {onRemove && <button onClick={onRemove} title={t("Aus Ludora entfernen")}><TrashIcon /></button>}
          </div>
        </div>
        <StatusPill status={game.status} update={game.update} running={running} />
        <HereBadge game={game} streamFrom={streamFrom} osName={osName} />
        {favorite && <span className="fav-badge" title={t("Favorit")}><StarIcon filled /></span>}
      </div>
      <div className="meta">
        <div className="name" title={game.name}>{game.name}</div>
        <div className="source">
          <LauncherLogo provider={provider} small />
          {provider?.name}
          {playtime && <span className="playtime">· {playtime}</span>}
        </div>
      </div>
    </article>)
  );
}

// Nur neu zeichnen, wenn sich etwas Sichtbares geändert hat (Handler rufen über eine Ref immer die aktuelle Funktion auf)
const same = (a, b) => a.game === b.game && a.provider === b.provider && a.launching === b.launching
  && a.running === b.running && a.favorite === b.favorite && a.streamFrom === b.streamFrom && !a.onUninstall === !b.onUninstall && !a.onRemove === !b.onRemove;
export default React.memo(GameCard, same);
