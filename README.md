# Hamilton e-Sign

Employee document signing for **ABR Quality Resources Inc dba Hamilton Exteriors**.

This is a modified build of [DocuSeal](https://github.com/docusealco/docuseal),
licensed **AGPL-3.0**. Because a modified version is served over a network, the
AGPL requires the source of the modifications be offered to users of the service.
That is what this repository is, and the signer page footer links here.

## What is modified

Only the signer-facing surface. The admin UI is untouched upstream.

| File | Change |
|---|---|
| `app/views/layouts/form.html.erb` | Loads DM Sans + the Hamilton brand stylesheet last |
| `app/assets/hamilton.css` | daisyUI theme tokens remapped to the Hamilton palette |
| `app/views/shared/_logo.html.erb` | Hamilton wordmark replaces the DocuSeal mark |
| `app/views/shared/_powered_by.html.erb` | Legal entity + CSLB + AGPL source notice |
| `lib/docuseal.rb` | `PRODUCT_NAME` constant |

Palette matches `hamilton-exteriors.com` (`src/styles/global.css`): primary
`rgb(37,99,70)`, deep `rgb(13,43,29)`, cream `rgb(244,241,235)`.

## Build

    docker build -t hamilton-esign .

Deployed on Railway (project `backoffice`, service `docuseal`).
