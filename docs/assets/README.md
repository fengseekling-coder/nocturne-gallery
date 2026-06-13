# Visual Asset Checklist

This folder is reserved for public README screenshots and workflow GIFs. Do not add placeholder or fake product screenshots. Capture these assets from the real app with a safe demo library when the first public alpha is ready.

The goal is not to create many images. The goal is to help a stranger understand the product in roughly 10 seconds:

- What does it look like?
- What problem does it solve?
- Why is it different from a normal image gallery?

## Minimum Public Screenshot Pack

Prepare these first:

- `screenshot-gallery.png`
- `screenshot-inspector.png`
- `screenshot-preview.png`
- `demo-import.gif`

The highest-priority asset is `screenshot-inspector.png`, because it shows the core difference: visual reference + prompt + source attachments in one local workspace.

## Required Assets

### `screenshot-gallery.png`

Purpose: answer "What does Gega Gallery look like?"

Show:

- Left sidebar with main groups and subgroups.
- Main gallery with different image sizes.
- A selected asset.
- Top search / import / grouping entry points if visible in the current UI.
- Dark desktop app visual quality.

Recommended demo content:

- Abstract UI references.
- Illustration references.
- Design mockups.
- AI-generated study images.
- Color palettes.
- Architecture, product, or icon references.

Avoid private client assets, personal photos, unpublished brand material, real user paths, and throwaway names such as `Untitled`, `test`, or `asdf`.

### `screenshot-inspector.png`

Purpose: show why this is not just another image wall.

Show:

- One selected image.
- Inspector panel.
- Prompt field.
- Metadata.
- Source attachments or related files.
- Group information.
- Duplicate, hash, or file info if already visible in the UI.

Recommended sample content:

```text
Prompt:
cinematic product shot, translucent glass object, soft rim light...

Attachments:
- source.psd
- brief.md
- color-reference.png
```

Use non-sensitive demo attachment names only.

### `screenshot-preview.png`

Purpose: show that the app is suitable for actually viewing, choosing, and managing visual references.

Show:

- Full-screen or large-image preview.
- Previous / next navigation if visible.
- Inspector or contextual panel synchronized to the active asset.
- File name, group, or short prompt context if visible.
- A clear path back to the gallery if visible.

### `demo-import.gif`

Purpose: show the core workflow from messy files to reusable creative context.

Recommended length: 12 to 20 seconds.

Show one simple flow:

```text
drag in a folder or image files
-> import progress appears
-> assets enter the gallery
-> select an image
-> edit prompt context
-> add a source attachment
-> drag the asset back out to another creative tool
```

Keep the GIF focused. It should answer: "Why use this instead of continuing with Finder folders?"

## Optional Assets

### `screenshot-duplicates.png`

Purpose: show that Gega Gallery helps keep a creative library from becoming messy over time.

Show:

- Duplicate asset confirmation.
- Existing asset location if visible.
- SHA-256 / perceptual hash context if visible in the UI.
- User choice to continue importing or use the existing asset.

This is useful near Features or roadmap material, but it does not need to be in the README first screen.

### `screenshot-groups.png`

Purpose: show that the project can support a long-running creative library.

Show:

- Main groups.
- Subgroups.
- Example demo sections such as Product References, UI Inspiration, AI Prompt Studies, and Color & Texture.
- Group isolation behavior if visible.

### `social-preview.png`

Purpose: GitHub social preview image.

Show:

- Product name.
- One-line positioning.
- A real app screenshot or carefully composed real capture.

## README Placement

Once the real assets exist, the README first screen should embed only the two strongest screenshots:

```md
## Preview

![Gega Gallery main gallery](docs/assets/screenshot-gallery.png)

![Inspector with prompt and attachments](docs/assets/screenshot-inspector.png)
```

Then place the workflow GIF under the Workflow section:

```md
## Workflow

![Import and reuse workflow](docs/assets/demo-import.gif)
```

Optional screenshots should go under More Screenshots or remain documented here.

Until those files exist, README should not embed them as images. Use text-only placeholders to avoid broken Markdown previews.

## Capture Guidelines

Recommended dimensions:

- Screenshot window: `1440 x 900`, `1600 x 1000`, or `1920 x 1200`.
- GIF capture: around `1280 x 800`.
- Format: PNG for screenshots, GIF or MP4 for motion.

Use one consistent desktop app window size across the required screenshots so the set feels like one product.

## Demo Library

Use a dedicated safe demo library such as:

```text
Gega Gallery Demo Library
  Product References
  UI Inspiration
  AI Prompt Studies
  Color & Texture
```

Avoid:

- Real user file paths such as `/Users/name/...`.
- API keys.
- Private photos.
- Client project names.
- Unpublished brand assets.
- Real chat logs.
- Debug panels.
- Console errors.
- Temporary test names.
