# Hamilton e-Sign — DocuSeal (AGPL-3.0) with Hamilton-branded signer views.
# Only the signer-facing surface is modified; the admin UI is upstream.
FROM docuseal/docuseal:latest

COPY brand/hamilton.css            /app/app/assets/hamilton.css
COPY brand/form.html.erb           /app/app/views/layouts/form.html.erb
COPY brand/_logo.html.erb          /app/app/views/shared/_logo.html.erb
COPY brand/_powered_by.html.erb    /app/app/views/shared/_powered_by.html.erb

# Product name is a Ruby constant upstream, not an env var.
RUN sed -i "s/PRODUCT_NAME = 'DocuSeal'/PRODUCT_NAME = 'Hamilton Exteriors'/" /app/lib/docuseal.rb \
 && grep -q "Hamilton Exteriors" /app/lib/docuseal.rb
