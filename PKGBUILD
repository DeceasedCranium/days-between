# Maintainer: local
pkgname=days-between
pkgver=1.6.2
pkgrel=1
pkgdesc="Days Between — Live music streaming desktop app, powered by Relisten (70,000+ concerts)"
arch=('any')
url="https://relisten.net"
license=('MIT')
depends=('electron39')
source=()
sha256sums=()

prepare() {
    cp -r "${startdir}/app"          "${srcdir}/"
    cp    "${startdir}/package.json" "${srcdir}/"
    cp -r "${startdir}/assets"       "${srcdir}/"
    cp -r "${startdir}/node_modules" "${srcdir}/"
    [[ -f "${startdir}/config.js" ]] && cp "${startdir}/config.js" "${srcdir}/"
}

package() {
    install -dm755 "${pkgdir}/opt/${pkgname}"
    cp -r "${srcdir}/app"          "${pkgdir}/opt/${pkgname}/"
    cp    "${srcdir}/package.json" "${pkgdir}/opt/${pkgname}/"
    cp -r "${srcdir}/assets"       "${pkgdir}/opt/${pkgname}/"
    cp -r "${srcdir}/node_modules" "${pkgdir}/opt/${pkgname}/"
    [[ -f "${srcdir}/config.js" ]] && cp "${srcdir}/config.js" "${pkgdir}/opt/${pkgname}/"

    # Launcher — finds whatever electron version is installed
    install -Dm755 /dev/stdin "${pkgdir}/usr/bin/${pkgname}" << 'SCRIPT'
#!/bin/sh
for e in electron electron39 electron34 electron33 electron32 electron31 electron30; do
    if command -v "$e" > /dev/null 2>&1; then
        exec "$e" /opt/days-between "$@"
    fi
done
echo "No electron binary found. Install electron or electron39 from the Arch repos." >&2
exit 1
SCRIPT

    install -Dm644 /dev/stdin "${pkgdir}/usr/share/applications/${pkgname}.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Days Between
GenericName=Music Player
Comment=Live music streaming — 70,000+ concerts, powered by Relisten
Exec=days-between %U
Icon=days-between
Terminal=false
Type=Application
Categories=Audio;Music;Player;
Keywords=music;live;concerts;streaming;grateful dead;phish;jamband;relisten;
StartupNotify=true
DESKTOP

    install -Dm644 "${srcdir}/assets/icon.svg" \
        "${pkgdir}/usr/share/icons/hicolor/scalable/apps/${pkgname}.svg"
    install -Dm644 "${srcdir}/assets/icon.png" \
        "${pkgdir}/usr/share/icons/hicolor/256x256/apps/${pkgname}.png"
    install -Dm644 "${srcdir}/assets/tray.png" \
        "${pkgdir}/usr/share/icons/hicolor/16x16/apps/${pkgname}.png"
}
