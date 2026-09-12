# Appearance and themes

Open **Settings → Appearance** to choose a theme and follow the system appearance or stay in light
or dark mode. To use different themes for light and dark mode, select the corresponding preview
within each theme. Appearance preferences are saved separately on each device or browser.

Phoenix Mobile includes the Phoenix, T3 Chat, Grove, Ocean, Ember, and Iris themes, plus its own
text, code, and terminal preferences. Each theme has light and dark colors that apply throughout
the app, including code reviews, file previews, the terminal, native headers, and sheets. Mobile
does not follow environment themes or defaults.

On supported iOS versions, the new-task and thread composers, working timer, and scroll-to-end
button use the system glass material. Other platforms use a themed background.

To change themes on mobile:

1. Open **Settings**.
2. Select **Appearance**.
3. Choose a theme.
4. Select **System**, **Light**, or **Dark**.

Tap a theme card to use it for both light and dark appearance. To mix themes, tap the light or dark
preview circle inside a card to change only that appearance. **System** follows the device
appearance automatically.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android also offers **Material You Layout**, which changes shapes and spacing independently
of the selected theme.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a Phoenix or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. app.t3.codes and additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, Phoenix falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
phoenix theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `phoenix theme set`. Run the command again to
reapply it, even if the name is unchanged.

`phoenix theme clear` removes the default without changing anyone's current theme. `phoenix theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from Phoenix into `~/.phoenix/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `phoenix theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. Phoenix
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.
