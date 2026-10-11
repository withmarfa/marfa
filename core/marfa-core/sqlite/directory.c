/* The synthetic name selects a retained directory, never a filesystem path.
** Native unixFile, inode locks and WAL mapping remain SQLite's implementation.
*/
#include <pthread.h>
#if defined(__linux__)
#include <sys/vfs.h>
#endif

struct MarfaDirectory {
  sqlite3_vfs vfs;
  int fd;
  char *prefix;
  int refs;
  int registered;
  MarfaDirectory *next;
};
static pthread_mutex_t marfaDirectoriesMutex = PTHREAD_MUTEX_INITIALIZER;
static MarfaDirectory *marfaDirectories = 0;

static MarfaDirectory *marfaRetain(const char *path){
  MarfaDirectory *p;
  pthread_mutex_lock(&marfaDirectoriesMutex);
  for(p=marfaDirectories; p; p=p->next){
    if( !strncmp(path, p->prefix, strlen(p->prefix)) ){
      p->refs++;
      break;
    }
  }
  pthread_mutex_unlock(&marfaDirectoriesMutex);
  return p;
}

static void marfaRelease(MarfaDirectory *p){
  MarfaDirectory **link;
  int destroy = 0;
  if( !p ) return;
  pthread_mutex_lock(&marfaDirectoriesMutex);
  if( --p->refs==0 ){
    for(link=&marfaDirectories; *link && *link!=p; link=&(*link)->next){}
    if( *link ) *link = p->next;
    destroy = 1;
  }
  pthread_mutex_unlock(&marfaDirectoriesMutex);
  if( destroy ){
    sqlite3_vfs_unregister(&p->vfs);
    osClose(p->fd);
    sqlite3_free((void*)p->vfs.zName); sqlite3_free(p->prefix); sqlite3_free(p);
  }
}

static int marfaDirectory(const char *path, const char **name){
  MarfaDirectory *p;
  int fd = -1;
  if( !path || strncmp(path, "/marfa-directory/", 17) ) return -1;
  pthread_mutex_lock(&marfaDirectoriesMutex);
  for(p=marfaDirectories; p; p=p->next){
    int n = (int)strlen(p->prefix);
    if( !strncmp(path, p->prefix, n) ){
      *name = path+n;
      if( !**name || strchr(*name, '/') || !strcmp(*name, ".") || !strcmp(*name, "..") ){
        errno = EINVAL;
        fd = -2;
      }else{
        fd = p->fd;
      }
      break;
    }
  }
  pthread_mutex_unlock(&marfaDirectoriesMutex);
  if( fd==-1 ) { errno = EBADF; return -2; }
  return fd;
}

static int marfaOpen(const char *path, int flags, mode_t mode){
  const char *name = 0;
  int fd = marfaDirectory(path, &name);
  int opened;
  struct stat info;
  if( fd==-1 ) return osOpen(path, flags, mode);
  if( fd<0 ) return -1;
  opened = openat(fd, name, flags|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK, 0600);
  if( opened>=0 && (fstat(opened, &info) || !S_ISREG(info.st_mode)) ){
    osClose(opened);
    errno = EINVAL;
    return -1;
  }
  return opened;
}
static int marfaStat(const char *path, struct stat *statbuf){
  const char *name = 0;
  int fd = marfaDirectory(path, &name);
  if( fd==-1 ) return osStat(path, statbuf);
  if( fd<0 ) return -1;
  if( fstatat(fd, name, statbuf, AT_SYMLINK_NOFOLLOW) ) return -1;
  if( S_ISLNK(statbuf->st_mode) ){ errno=ELOOP; return -1; }
  return 0;
}
static int marfaLstat(const char *path, struct stat *statbuf){
  const char *name = 0;
  int fd = marfaDirectory(path, &name);
  if( fd==-1 ) return osLstat(path, statbuf);
  return fd<0 ? -1 : fstatat(fd, name, statbuf, AT_SYMLINK_NOFOLLOW);
}
static int marfaAccess(const char *path, int flags){
  const char *name = 0;
  struct stat statbuf;
  int fd = marfaDirectory(path, &name);
  if( fd==-1 ) return osAccess(path, flags);
  if( fd<0 || marfaStat(path, &statbuf) ) return -1;
  return faccessat(fd, name, flags, AT_EACCESS|AT_SYMLINK_NOFOLLOW);
}
static int marfaUnlink(const char *path){
  const char *name = 0;
  int fd = marfaDirectory(path, &name);
  if( fd==-1 ) return osUnlink(path);
  if( fd<0 ) return -1;
  return unlinkat(fd, name, 0);
}
static int marfaOpenDirectory(const char *path, int *out){
  const char *name = 0;
  int fd = marfaDirectory(path, &name);
  if( fd==-1 ) return osOpenDirectory(path, out);
  if( fd<0 ) return SQLITE_CANTOPEN;
  *out = fcntl(fd, F_DUPFD_CLOEXEC, SQLITE_MINIMUM_FILE_DESCRIPTOR);
  return *out<0 ? SQLITE_CANTOPEN : SQLITE_OK;
}

static int marfaOpenFile(sqlite3_vfs*, const char*, sqlite3_file*, int, int*);
static int marfaTempname(sqlite3_vfs*, int, char*);
