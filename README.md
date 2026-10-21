# MoonTV for LG webOS

[English](README.md) · [中文](README.zh-CN.md)

Watch your [MoonTV / LunaTV](https://github.com/MoonTechLab/LunaTV) library on an older LG TV, with the remote.

## What this is

MoonTV ships a web UI that works fine on phones and laptops. On LG TVs from around 2018 it does not load at all: the browser engine inside those TVs is Chrome 53, which cannot run the JavaScript MoonTV is built with. You get a page of text, no posters, nothing to click.

This project is a separate TV interface for the same MoonTV. It installs as its own app on the TV and only does display and remote-control handling. The data still comes from your MoonTV, through a small relay service (called the "bridge" below) that runs in Docker next to MoonTV.

![Home](docs/screenshots/01-home.jpg)

| Browse by category, with filters | Built-in pinyin keyboard |
|---|---|
| ![Browse](docs/screenshots/02-browse.jpg) | ![Pinyin keyboard](docs/screenshots/03-pinyin-keyboard.jpg) |

## What it does

**Works with the remote.** Arrow keys move, OK selects, Back goes up a level. Text is large enough to read from the couch.

**Chinese input without hunting for letters.** European LG TVs have no Chinese input method, so the app brings its own pinyin keyboard. It takes full pinyin and initials (`lxrg` finds 兰香如故), and it pulls recent titles from your MoonTV for suggestions.

**Type on your phone instead.** A QR code sits next to the keyboard. Scan it with a phone on the same Wi-Fi and a plain input page opens; type there, tap once, and the text lands on the TV. Nothing to install on the phone.

| TV: keyboard with QR code | Phone: input page |
|---|---|
| ![TV keyboard with QR](docs/screenshots/04-phone-qr.jpg) | <img src="docs/screenshots/05-phone-input.jpg" width="260" alt="Phone input page"> |

**Browse like the web.** Each category page has the same filters as MoonTV's web UI, including the 全部 tab with sort (综合 / 近期热度 / 首映时间 / 高分优先), genre, region, year and platform. Favourites, skip-intro/outro settings and play history are shared with the web UI.

**Several people, separate accounts.** Each person logs in with their MoonTV account once and the TV remembers it. Next time the TV starts straight into whoever used it last. To switch, select the user name in the top bar to log out; a picker with one tile per account appears, and selecting a tile logs in without a password.

**Try it without a TV.** Open `http://<bridge>:8788/` in a desktop browser and you get a scaled-down "TV" running the exact same app, with a clickable remote drawn next to it. Handy when changing things.

## What you need

- An LG webOS TV. Developed and tested on webOS 4.4 (a 2018 OLED B8); newer models should work too.
- A running MoonTV deployed with Docker.
- Developer Mode on the TV, which is how LG lets you install your own apps. Install LG's free "Developer Mode" app from the TV's store and sign in with an LG developer account. Sessions expire (1000 hours on current firmware); press Extend in that app before they do.
- A computer with Node.js for packaging and installing.

## Setup

### Step 1: add the bridge next to MoonTV

The bridge is a small Python program packaged as a Docker image. It belongs in the same compose file as MoonTV. Open your MoonTV `docker-compose.yml`, copy the service from [api-go/compose.snippet.yml](api-go/compose.snippet.yml) into it, and change three things:

- `MOONTV_USER` and `MOONTV_PASS`: a MoonTV account the bridge logs in with.
- The network name must match the one `moontv-core` uses.
- The port is 8788 by default; leave it unless it clashes with something.

The image builds straight from this repository's GitHub URL, so nothing needs to be checked out on the server. Run `docker compose up -d --build`, or update the stack in Portainer.

To check it worked, open `http://<server-ip>:8788/` in a browser. If the simulated TV shows up, the bridge is running.

If you would rather not touch the MoonTV compose file, the bridge also runs on its own:

```bash
docker build -t moontv-api -f api-go/Dockerfile https://github.com/coomteng/moontv-webos.git#main
docker run -d -p 8788:8788 \
  -e MOONTV_UPSTREAM=http://<moontv-host>:3000 \
  -e MOONTV_USER=<user> -e MOONTV_PASS=<password> \
  moontv-api
```

### Step 2: install the app on the TV

On your computer:

```bash
npm install -g @webos-tools/cli
git clone https://github.com/coomteng/moontv-webos.git
cd moontv-webos

# tell the app where the bridge is (this file is git-ignored)
echo 'BRIDGE_BASE=http://<server-ip>:8788' > local.env

# register the TV: enter its IP, port 9922, user "prisoner";
# then turn on Key Server in the TV's Developer Mode app and type the 6-character passphrase it shows
ares-setup-device
ares-novacom --device <tv-name> --getkey

# package and install
tools/build_ipk.sh
ares-install --device <tv-name> dist/*.ipk
```

A MoonTV icon appears on the TV's home screen. The first launch asks for a MoonTV login; after that it remembers.

Remote-key reference, updating, and pre-provisioned accounts are described in [app/README.md](app/README.md).

## Questions

**Why a bridge at all? Can't the TV talk to MoonTV directly?**
The TV app starts from a local file, and browsers refuse to send MoonTV's login cookie from that origin. MoonTV accepts no other form of authentication, so the bridge logs in on the TV's behalf and passes the data through. It is a single static Go binary.

**Is it safe?**
The bridge has no access control and is meant for a home network only. Do not expose port 8788 to the internet.

**If it works in the simulator, will it work on the TV?**
Not necessarily. A desktop browser is years ahead of the TV. The repository includes a syntax check that keeps the code within what Chrome 53 understands, but a final test on the real TV is still needed.

## Repository layout

| Directory | Contents |
|---|---|
| `app/` | The TV app. Plain HTML, CSS and JavaScript, no build step. |
| `api-go/` | The bridge: a static Go binary (9 MB), 18 MB image, 8–16 MB RSS. Dockerfile and compose snippet included. |
| `sim/` | The simulated-TV page shown in a desktop browser. |
| `tools/` | `build_ipk.sh` for packaging, `gen_pinyin.py` for the pinyin table. |
| `test/` | Headless walk-through script that runs without a TV. |

## License

MIT
