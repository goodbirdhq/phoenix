# Running Phoenix in the Background

Phoenix's inherited Linux background-service implementation requires an exact-version package
distribution. Phoenix is not published to npm, so new background-service installs and updates are
currently disabled: installing the upstream `t3` package would run a different product.

For now, run the source-built server in a terminal or create a service definition you manage
yourself. To update a server you run that way, follow the
[self-managed server update runbook](../operations/updating-a-self-managed-server.md). Do not run `phoenix service install` or `phoenix service update` until Phoenix has an owned
package identity and this page announces that distribution.

If an older Phoenix background service is already installed, you can inspect it:

```sh
phoenix service status
```

You can stop it and remove it from startup:

```sh
phoenix service uninstall
```

T3 Connect and the background service have independent lifecycles. Signing out of T3 Connect does
not remove an existing service.
