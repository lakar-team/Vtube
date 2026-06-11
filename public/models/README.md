# VRM models

Drop your VRM avatar file in this folder and name it `avatar.vrm`:

```
public/models/avatar.vrm
```

The app loads `/models/avatar.vrm` first. If it is missing, it falls back to a
free-licensed sample model fetched from the three-vrm repository
(`VRM1_Constraint_Twist_Sample.vrm`, MIT-licensed example asset from
https://github.com/pixiv/three-vrm). The fallback requires an internet
connection and is a minimal test model — get a real avatar for actual use.

Where to get a free VRM:

- VRoid Hub (https://hub.vroid.com) — check each model's license; many allow
  personal streaming use. Download as `.vrm`.
- Make your own with VRoid Studio (free, https://vroid.com/en/studio) and
  export as VRM 0.x or VRM 1.0 — both work with this app.
- three-vrm sample models: https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/examples/models

Both VRM 0.x and VRM 1.0 are supported. The rig mapper auto-detects the
version and flips rotation signs accordingly (see `src/vrm/applyMocapToVRM.ts`).

Note: `.vrm` files are large binaries. Avoid committing them to git unless the
license explicitly allows redistribution.
