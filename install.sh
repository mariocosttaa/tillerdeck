#!/bin/sh
# Instala a última Tillerdeck a partir das releases do GitHub.
#
#   curl -fsSL https://raw.githubusercontent.com/mariocosttaa/tillerdeck/main/install.sh | sh
#
# macOS (Apple Silicon): a app vai para /Applications (ou ~/Applications sem
# permissão). Descarregada com curl, não leva a marca de quarentena do browser,
# por isso abre sem o aviso do Gatekeeper.
# Linux (x86_64, arm64): o AppImage vai para ~/.local/bin/tillerdeck.
#
# Confere o SHA-256 com o ficheiro de checksums da release antes de instalar.
set -eu

REPO="mariocosttaa/tillerdeck"
say() { printf '%s\n' "$*"; }
die() { say "tillerdeck: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "falta o comando '$1'"; }
need curl

tag="${TILLERDECK_VERSION:-}"
if [ -z "$tag" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || die "não consegui saber a última versão"
fi
v="${tag#v}"
base="https://github.com/$REPO/releases/download/$tag"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1
}
fetch() { # ficheiro, ficheiro de checksums
  say "A descarregar $1…"
  curl -fL --progress-bar -o "$tmp/$1" "$base/$1"
  curl -fsSL -o "$tmp/sums.txt" "$base/$2"
  want=$(grep " $1\$" "$tmp/sums.txt" | cut -d' ' -f1)
  [ -n "$want" ] || die "o $1 não está em $2"
  [ "$(sha256 "$tmp/$1")" = "$want" ] || die "o SHA-256 do $1 não bate certo — não instalei nada"
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    f="Tillerdeck-$v-macos-arm64.zip"
    fetch "$f" "SHA256SUMS-macos-arm64.txt"
    need ditto
    ditto -x -k "$tmp/$f" "$tmp/app"
    dest="/Applications"
    [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
    rm -rf "$dest/Tillerdeck.app"
    ditto "$tmp/app/Tillerdeck.app" "$dest/Tillerdeck.app"
    xattr -dr com.apple.quarantine "$dest/Tillerdeck.app" 2>/dev/null || true
    say "Tillerdeck $v instalada em $dest/Tillerdeck.app"
    say "Abrir: open -a Tillerdeck"
    ;;
  Darwin-*)
    die "por agora só há build para Mac com Apple Silicon"
    ;;
  Linux-x86_64 | Linux-aarch64)
    arch=$(uname -m)
    f="Tillerdeck-$v-linux-$arch.AppImage"
    fetch "$f" "SHA256SUMS-linux-$arch.txt"
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$tmp/$f" "$HOME/.local/bin/tillerdeck"
    say "Tillerdeck $v instalada em ~/.local/bin/tillerdeck"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Junta ~/.local/bin ao PATH para correr 'tillerdeck'." ;; esac
    ;;
  *)
    die "sistema não suportado: $(uname -s) $(uname -m)"
    ;;
esac
