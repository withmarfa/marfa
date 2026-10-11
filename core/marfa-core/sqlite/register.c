static int marfaTempname(sqlite3_vfs *vfs, int size, char *out){
  MarfaDirectory *p;
  unsigned char random[16];
  if( vfs->xOpen!=marfaOpenFile ) return unixGetTempname(size, out);
  p = (MarfaDirectory*)vfs;
  sqlite3_randomness(sizeof(random), random);
  sqlite3_snprintf(size-1, out, "%s.sqlite-temp-%02x%02x%02x%02x%02x%02x%02x%02x", p->prefix, random[0], random[1], random[2], random[3], random[4], random[5], random[6], random[7]);
  out[strlen(out)+1] = 0;
  return SQLITE_OK;
}

static int marfaOpenFile(sqlite3_vfs *vfs, const char *path, sqlite3_file *file, int flags, int *out){
  MarfaDirectory *p = (MarfaDirectory*)vfs;
  const char *name;
  if( path && marfaDirectory(path, &name)!=p->fd ) return SQLITE_CANTOPEN;
  int rc = unixOpen(vfs, path, file, flags, out);
  if( rc==SQLITE_OK ){
    pthread_mutex_lock(&marfaDirectoriesMutex);
    p->refs++;
    pthread_mutex_unlock(&marfaDirectoriesMutex);
    ((unixFile*)file)->marfaDirectory = p;
  }
  return rc;
}

static int marfaFullPathname(sqlite3_vfs *vfs, const char *path, int size, char *out){
  MarfaDirectory *p = (MarfaDirectory*)vfs;
  const char *name = path;
  int prefix = (int)strlen(p->prefix);
  if( !strncmp(path, p->prefix, prefix) ) name = path+prefix;
  if( !*name || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..") ) return SQLITE_CANTOPEN;
  if( prefix+(int)strlen(name)+1>=size ) return SQLITE_CANTOPEN;
  sqlite3_snprintf(size, out, "%s%s", p->prefix, name);
  return SQLITE_OK;
}

/* One translation unit defines this symbol and all SQLite exports. Linking
** two runtimes therefore fails with duplicate symbols instead of separating
** their inode and shared-memory lock registries.
*/
SQLITE_API int marfa_directory_vfs_register(int fd, const char *name){
  sqlite3_vfs *native;
  MarfaDirectory *p;
  int rc = sqlite3_initialize();
  if( rc!=SQLITE_OK ) return rc;
  native = sqlite3_vfs_find("unix");
  if( !native ) return SQLITE_NOTFOUND;
  p = sqlite3_malloc64(sizeof(*p));
  if( !p ) return SQLITE_NOMEM;
  memset(p, 0, sizeof(*p));
  p->vfs = *native;
  p->vfs.pNext = 0;
  p->vfs.zName = sqlite3_mprintf("%s", name);
  p->prefix = sqlite3_mprintf("/marfa-directory/%s/", name);
  p->fd = fcntl(fd, F_DUPFD_CLOEXEC, SQLITE_MINIMUM_FILE_DESCRIPTOR);
  p->vfs.xFullPathname = marfaFullPathname;
  p->vfs.xOpen = marfaOpenFile;
  p->refs = 1;
  p->registered = 1;
  if( !p->vfs.zName || !p->prefix || p->fd<0 ){
    if( p->fd>=0 ) osClose(p->fd);
    sqlite3_free((void*)p->vfs.zName); sqlite3_free(p->prefix); sqlite3_free(p);
    return SQLITE_NOMEM;
  }
  pthread_mutex_lock(&marfaDirectoriesMutex);
  p->next = marfaDirectories;
  marfaDirectories = p;
  pthread_mutex_unlock(&marfaDirectoriesMutex);
  rc = sqlite3_vfs_register(&p->vfs, 0);
  if( rc!=SQLITE_OK ) marfaRelease(p);
  return rc;
}

SQLITE_API void marfa_directory_vfs_unregister(const char *name){
  MarfaDirectory *p;
  pthread_mutex_lock(&marfaDirectoriesMutex);
  for(p=marfaDirectories; p; p=p->next){
    if( p->registered && !strcmp(p->vfs.zName, name) ){
      p->registered = 0;
      break;
    }
  }
  pthread_mutex_unlock(&marfaDirectoriesMutex);
  if( p ){
    marfaRelease(p);
  }
}

SQLITE_API int marfa_directory_vfs_supported(int fd){
#if defined(__APPLE__)
  struct statfs info;
  if( fstatfs(fd, &info) ) return SQLITE_IOERR_FSTAT;
  if( strcmp(info.f_fstypename, "apfs") && strcmp(info.f_fstypename, "hfs") && strcmp(info.f_fstypename, "ufs") && strcmp(info.f_fstypename, "msdos") && strcmp(info.f_fstypename, "exfat") ) return SQLITE_NOTFOUND;
  return SQLITE_OK;
#elif defined(__linux__)
  struct statfs info;
  if( fstatfs(fd, &info) ) return SQLITE_IOERR_FSTAT;
  if( info.f_type==0x6969 || info.f_type==0xFF534D42 || info.f_type==0xFE534D42 || info.f_type==0x517B ) return SQLITE_NOTFOUND;
  return SQLITE_OK;
#else
  return SQLITE_NOTFOUND;
#endif
}
