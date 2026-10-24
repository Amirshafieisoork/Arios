-- Dedicated private project documents and report photos. Browser roles receive no object policies.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('arios-project-files', 'arios-project-files', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
