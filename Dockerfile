# Hamilton e-Sign — DocuSeal (AGPL-3.0) with Hamilton-branded signer views.
# Only the signer-facing surface is modified; the admin UI is upstream.
# PINNED, deliberately. Every CSS selector and ERB override in brand/ is written
# against this specific build's markup — the field-marker recolor targets
# page-container, the stepper targets the language-neutral .steps-progress class,
# completion attribution targets a docuseal.com anchor. Upstream shipped 3.1.6 on
# 2026-07-27; on :latest the next deploy would silently pull it and any markup
# change would break the branding with no error anywhere. Bump this on purpose,
# then re-verify the signer page, never by accident.
# ---------------------------------------------------------------- webpack ----
# Recompile DocuSeal's signer components with the inline-field patch.
#
# Needed because DocuSeal has no reflow mode at any tier, and its front end is
# where a field decides whether it is a box positioned over a page image or an
# element in a line of text. The runtime image ships the Vue source but no
# package.json and no node, so the assets cannot be rebuilt in place.
#
# Mirrors upstream's own webpack stage exactly (ruby:4.0.5-alpine plus
# nodejs/yarn/git/build-base and the shakapacker gem). Verified beforehand that a
# NO-OP recompile of 3.1.5 reproduces the pack content hashes already running in
# production, so a patched build differs only by the patch.
FROM ruby:4.0.5-alpine@sha256:f48938e9ae72a4d32e728b03c306e7a7ff21f0cb6c2ed33f44a078c700b2aea6 AS webpack

ENV RAILS_ENV=production
ENV NODE_ENV=production

WORKDIR /src

RUN apk add --no-cache \
      nodejs=24.17.0-r0 \
      yarn=1.22.22-r1 \
      git=2.54.0-r0 \
      build-base=0.5-r4 && \
    gem install shakapacker -v 9.7.0 --no-document

ARG DOCUSEAL_COMMIT=5fe75c84ffc71d1e879884f453a7532b4dee049a
RUN git init . && \
    git remote add origin https://github.com/docusealco/docuseal.git && \
    git fetch --depth 1 origin "$DOCUSEAL_COMMIT" && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = "$DOCUSEAL_COMMIT"

# Every edit asserts its anchor text, so an upstream change fails the build here
# rather than shipping a bundle where fields silently capture nothing.
COPY patches/docuseal-inline-fields.mjs /patches/
RUN node /patches/docuseal-inline-fields.mjs /src/app/javascript/submission_form

RUN yarn install --frozen-lockfile --network-timeout 1000000

RUN echo "gem 'shakapacker', '9.7.0'" > Gemfile && ./bin/shakapacker && \
    test -f /src/public/packs/manifest.json

# ------------------------------------------------------------------- app -----
FROM docuseal/docuseal:3.1.5@sha256:d20b62c1eac8719d2ffa31188d83866cf1b0d41c1aeea01c37bd850ef32cb517

# The patched bundle, replacing the whole packs tree so the manifest and its
# content-hashed filenames stay consistent with each other.
COPY --from=webpack /src/public/packs /app/public/packs

COPY brand/hamilton.css            /app/app/assets/hamilton.css
COPY brand/hamilton.yml            /app/config/locales/hamilton.yml
COPY brand/form.html.erb           /app/app/views/layouts/form.html.erb
COPY brand/_logo.html.erb          /app/app/views/shared/_logo.html.erb
COPY brand/_powered_by.html.erb    /app/app/views/shared/_powered_by.html.erb
# Logo lockup: mark only. Upstream renders the mark AND the product name as
# text, printing the same words twice. There are TWO such partials — the signing
# view and the start view — and the start one hardcodes <h1>DocuSeal</h1>, so
# overriding only submit_form leaves the name on screen.
COPY brand/_docuseal_logo.html.erb    /app/app/views/submit_form/_docuseal_logo.html.erb
COPY brand/_start_form_logo.html.erb  /app/app/views/start_form/_docuseal_logo.html.erb

# Self-hosted fonts. The upstream CSP (style-src 'self' 'unsafe-inline') blocks
# fonts.googleapis.com, so an external font stylesheet never loads at all.
COPY brand/fonts/                  /app/public/fonts/

# Mobile reading views: the same document set reflowed for a phone, plus an index
# keyed by template name. DocuSeal rasterises pages and scales the image, so at
# Letter a phone gets ~0.46 scale and 10.5pt body type lands near 6.4 CSS px.
# Two renderings of one source is how Adobe (Liquid Mode) and DocuSign
# (Responsive Signing) both solve this; the PDF stays the signed record.
COPY brand/reflow/                 /app/public/reflow/

# shared/_title hardcodes the literal "DocuSeal", surviving the PRODUCT_NAME rewrite.
COPY brand/_title.html.erb         /app/app/views/shared/_title.html.erb

# Decline modal. Upstream's copy ("Notify the sender with the reason you
# declined") names a side effect and never says that this refuses to sign, and
# the only ways out were a 24px glyph and an invisible backdrop. The override
# states the consequence, in the signer's language, and adds a labelled way back.
COPY brand/_decline_form.html.erb  /app/app/views/submit_form/_decline_form.html.erb

# Root page: upstream is a DocuSeal product page under Hamilton's logo.
COPY brand/_landing.html.erb       /app/app/views/pages/landing.html.erb
COPY brand/application.html.erb      /app/app/views/layouts/application.html.erb
COPY brand/_public_root_navbar.html.erb /app/app/views/shared/_public_root_navbar.html.erb

# Public signer recovery, verification, terminal states and Rails error pages.
# These map only to public routes, leaving authenticated admin views upstream.
COPY brand/_signer_recovery.html.erb /app/app/views/shared/_signer_recovery.html.erb
COPY brand/_terminal_state.html.erb  /app/app/views/shared/_terminal_state.html.erb
COPY brand/_submit_email_2fa.html.erb /app/app/views/submit_form/email_2fa.html.erb
COPY brand/_start_email_verification.html.erb /app/app/views/start_form/email_verification.html.erb
COPY brand/_start_show.html.erb      /app/app/views/start_form/show.html.erb
COPY brand/_submit_awaiting.html.erb /app/app/views/submit_form/awaiting.html.erb
COPY brand/_submit_completed.html.erb /app/app/views/submit_form/completed.html.erb
COPY brand/_submit_declined.html.erb /app/app/views/submit_form/declined.html.erb
COPY brand/_submit_delegated.html.erb /app/app/views/submit_form/delegated.html.erb
COPY brand/_submit_expired.html.erb  /app/app/views/submit_form/expired.html.erb
COPY brand/_submit_archived.html.erb /app/app/views/submit_form/archived.html.erb
COPY brand/_submit_success.html.erb  /app/app/views/submit_form/success.html.erb
COPY brand/_start_completed.html.erb /app/app/views/start_form/completed.html.erb
COPY brand/404.html                  /app/app/views/errors/404.html
COPY brand/422.html                  /app/app/views/errors/422.html
COPY brand/500.html                  /app/app/views/errors/500.html

# Browser tab: title, meta and favicons.
COPY brand/_head_tags.html.erb     /app/app/views/layouts/_head_tags.html.erb
COPY brand/_meta.html.erb          /app/app/views/shared/_meta.html.erb
# /favicon.ico is the path browsers request by DEFAULT (no <link> needed) and
# cache hardest, so leaving it upstream means the DocuSeal mark keeps showing.
COPY brand/icons/favicon.ico       /app/public/favicon.ico
COPY brand/icons/favicon.svg       /app/public/favicon.svg
COPY brand/icons/favicon-16.png    /app/public/favicon-16x16.png
COPY brand/icons/favicon-32.png    /app/public/favicon-32x32.png
COPY brand/icons/favicon-96.png    /app/public/favicon-96x96.png
COPY brand/icons/favicon-180.png   /app/public/apple-icon-180x180.png
COPY brand/icons/favicon-180.png   /app/public/apple-touch-icon.png
COPY brand/icons/favicon-180.png   /app/public/apple-touch-icon-precomposed.png

# Product name is a Ruby constant upstream, not an env var.
RUN sed -i "s/PRODUCT_NAME = 'DocuSeal'/PRODUCT_NAME = 'Hamilton Exteriors'/" /app/lib/docuseal.rb \
 && grep -q "Hamilton Exteriors" /app/lib/docuseal.rb

# Each view hardcodes its own tab title as "<doc> | DocuSeal" via content_for,
# so the layout fallback never fires. Rewrite the suffix at the source.
RUN find /app/app/views -name '*.erb' -exec sed -i 's/ | DocuSeal"/ | Hamilton Signing"/g' {} + \
 && ! grep -rq '| DocuSeal"' /app/app/views
