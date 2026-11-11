#!/bin/sh
# Übergang von der Electron-Version (.deb): deren Updater startet nach dem Update "/opt/Ludora/ludora".
# Die Rust-Version liegt unter /usr/bin – dorthin weiterreichen.
for b in /usr/bin/ludora /usr/bin/Ludora; do
  [ -x "$b" ] && exec "$b" "$@"
done
exit 1
