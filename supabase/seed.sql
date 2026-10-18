-- supabase/seed.sql
INSERT INTO courses (id, course_code, course_title) VALUES
    ('00000000-0000-0000-0000-000000000001', 'CSC148H5', 'Introduction to Computer Science'),
    ('00000000-0000-0000-0000-000000000002', 'CSC207H5', 'Software Design'),
    ('00000000-0000-0000-0000-000000000003', 'CSC258H5', 'Computer Organization'),
    ('00000000-0000-0000-0000-000000000004', 'CSC263H5', 'Data Structures and Analysis'),
    ('00000000-0000-0000-0000-000000000005', 'MAT102H5', 'Introduction to Mathematical Proofs'),
    ('00000000-0000-0000-0000-000000000006', 'MAT232H5', 'Calculus of Several Variables'),
    ('00000000-0000-0000-0000-000000000007', 'STA256H5', 'Probability and Statistics')
ON CONFLICT (id) DO NOTHING;